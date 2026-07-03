import {
  FLAG_UNCOMPRESSED,
  SDK_FLUSH_DEFAULT_MS,
  configKvKey,
  decodeIngestBody,
  startWideEvent,
  WireError,
} from "@orange-replay/shared";
import type { EdgeAttrs, IngestAck, ProjectConfig, WideEventOutcome } from "@orange-replay/shared";
import type { AppendArgs } from "../do/contract.ts";
import { shardDb } from "../env.ts";
import type { Env } from "../env.ts";
import {
  INGEST_POST_HEADERS,
  INGEST_PREFLIGHT_HEADERS,
  MAX_INGEST_BODY_BYTES,
  mapConfigRowToProjectConfig,
  parseProjectConfig,
  readContentLength,
  sha256Hex,
  validateIngestHeaders,
} from "./helpers.ts";
import type { ProjectConfigRow } from "./helpers.ts";

const CONFIG_READ_QUERY =
  "SELECT k.project_id AS projectId, k.active AS active, p.org_id AS orgId, p.retention_days AS retentionDays, p.jurisdiction AS jurisdiction, p.sample_rate AS sampleRate, p.allowed_origins AS allowedOrigins, p.mask_policy_version AS maskPolicyVersion, p.quota_state AS quotaState, o.shard AS shard FROM keys k JOIN projects p ON p.id = k.project_id JOIN orgs o ON o.id = p.org_id WHERE k.key_hash = ?";

export function handleIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") {
    return Promise.resolve(new Response(null, { status: 204, headers: INGEST_PREFLIGHT_HEADERS }));
  }

  if (request.method !== "POST") {
    return Promise.resolve(jsonResponse({ error: "method not allowed" }, 405));
  }

  return handleIngestPost(request, env, ctx);
}

async function handleIngestPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const event = startWideEvent("worker", "ingest.batch", requestId);
  let statusCode = 500;
  let outcome: WideEventOutcome = "server_error";

  const finish = <Body>(body: Body, status: number, nextOutcome: WideEventOutcome): Response => {
    statusCode = status;
    outcome = nextOutcome;
    return jsonResponse(body, status);
  };

  try {
    const headersResult = validateIngestHeaders(request.headers);
    if (!headersResult.ok) {
      return finish({ error: headersResult.error }, 400, "client_error");
    }

    const { key, sessionId, tab, seq, flags } = headersResult.value;
    let cleanedFlags = flags;
    event.set({ session_id: sessionId, tab, seq, flags: cleanedFlags });

    const contentLength = readContentLength(request.headers);
    if (contentLength !== undefined) {
      event.set({ bytes_in: contentLength });
      if (contentLength > MAX_INGEST_BODY_BYTES) {
        return finish({ error: "ingest body is too large" }, 413, "client_error");
      }
    }

    const keyHash = await sha256Hex(key);
    const configResult = await loadProjectConfig(env, ctx, keyHash);
    event.set({ kv_hit: configResult.kvHit });

    const config = configResult.config;
    if (config !== null) {
      event.set({
        project_id: config.projectId,
        org_id: config.orgId,
        quota_state: config.quotaState,
      });
    }

    if (config === null || !config.active) {
      return finish({ error: "unknown or inactive ingest key" }, 401, "client_error");
    }

    if (!originIsAllowed(request, config.allowedOrigins)) {
      return finish({ error: "origin is not allowed" }, 403, "client_error");
    }

    if (config.quotaState === "exceeded") {
      event.set({ live: false });
      return finish(
        { ok: true, live: false, flushMs: SDK_FLUSH_DEFAULT_MS, drop: true } satisfies IngestAck,
        202,
        "dropped",
      );
    }

    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    event.set({ bytes_in: bodyBytes.byteLength });
    if (bodyBytes.byteLength > MAX_INGEST_BODY_BYTES) {
      return finish({ error: "ingest body is too large" }, 413, "client_error");
    }

    let decoded: ReturnType<typeof decodeIngestBody>;
    try {
      decoded = decodeIngestBody(bodyBytes);
    } catch (error) {
      if (error instanceof WireError) {
        return finish({ error: error.message }, 400, "client_error");
      }
      throw error;
    }

    const mismatchError = indexMismatchError(decoded.index, sessionId, tab, seq);
    if (mismatchError !== null) {
      return finish({ error: mismatchError }, 400, "client_error");
    }

    let payload = decoded.payload;
    if ((flags & FLAG_UNCOMPRESSED) !== 0) {
      payload = await gzipPayload(payload);
      cleanedFlags = flags - FLAG_UNCOMPRESSED;
      event.set({ flags: cleanedFlags });
    }

    const attrs = attrsFromRequest(request);
    const namespace = config.jurisdiction
      ? env.SESSION.jurisdiction(config.jurisdiction)
      : env.SESSION;
    const stub = namespace.get(namespace.idFromName(`${config.projectId}:${sessionId}`));
    const result = await stub.appendBatch({
      requestId,
      projectId: config.projectId,
      orgId: config.orgId,
      shard: config.shard,
      retentionDays: config.retentionDays,
      sessionId,
      tab,
      seq,
      flags: cleanedFlags,
      index: decoded.index,
      payload,
      attrs,
      receivedAt: Date.now(),
    } satisfies AppendArgs);

    writeTrend(env, config.projectId, attrs.country, payload.byteLength);
    event.set({ flags: cleanedFlags, live: result.live });

    return finish(
      {
        ok: true,
        live: result.live,
        closed: result.closed || undefined,
        flushMs: result.flushMs,
      } satisfies IngestAck,
      200,
      "success",
    );
  } catch (error) {
    event.fail(error);
    return finish({ error: "ingest failed" }, 500, "server_error");
  } finally {
    event.set({ status_code: statusCode });
    event.emit(outcome);
  }
}

async function loadProjectConfig(
  env: Env,
  ctx: ExecutionContext,
  keyHash: string,
): Promise<{ config: ProjectConfig | null; kvHit: boolean }> {
  const kvConfig = parseProjectConfig(await getCachedProjectConfig(env, keyHash));
  if (kvConfig !== null) {
    return { config: kvConfig, kvHit: true };
  }

  const row = await shardDb(env, 0)
    .prepare(CONFIG_READ_QUERY)
    .bind(keyHash)
    .first<ProjectConfigRow>();
  const d1Config = mapConfigRowToProjectConfig(row ?? null);
  if (d1Config !== null) {
    ctx.waitUntil(env.CONFIG.put(configKvKey(keyHash), JSON.stringify(d1Config)));
  }

  return { config: d1Config, kvHit: false };
}

async function getCachedProjectConfig(env: Env, keyHash: string): Promise<unknown> {
  try {
    return await env.CONFIG.get(configKvKey(keyHash), { type: "json", cacheTtl: 60 });
  } catch {
    return null;
  }
}

function originIsAllowed(request: Request, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    return true;
  }

  const origin = request.headers.get("origin");
  return origin !== null && allowedOrigins.includes(origin);
}

function indexMismatchError(
  index: { s: string; tab: string; seq: number },
  sessionId: string,
  tab: string,
  seq: number,
): string | null {
  if (index.s !== sessionId) {
    return "ingest index session does not match the session header";
  }

  if (index.tab !== tab) {
    return "ingest index tab does not match the tab header";
  }

  if (index.seq !== seq) {
    return "ingest index seq does not match the seq header";
  }

  return null;
}

async function gzipPayload(payload: Uint8Array): Promise<Uint8Array> {
  const body = new Response(payload).body;
  if (body === null) {
    throw new Error("payload gzip failed");
  }

  const compressed = await new Response(
    body.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

function attrsFromRequest(request: Request): EdgeAttrs {
  const cf = request.cf as Record<string, unknown> | undefined;
  if (cf === undefined) {
    return {};
  }

  return {
    country: readString(cf["country"]),
    region: readString(cf["regionCode"]),
    city: readString(cf["city"]),
    asn: readNumber(cf["asn"]),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function writeTrend(
  env: Env,
  projectId: string,
  country: string | undefined,
  payloadBytes: number,
): void {
  try {
    env.TRENDS?.writeDataPoint({
      indexes: [projectId],
      blobs: [country ?? ""],
      doubles: [1, payloadBytes],
    });
  } catch {
    // Analytics Engine must never make ingest fail.
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: INGEST_POST_HEADERS });
}
