import {
  FLAG_UNCOMPRESSED,
  HDR_REQUEST_ID,
  MAX_COMPRESSED_BATCH_BYTES,
  SDK_FLUSH_DEFAULT_MS,
  configKvKey,
  decodeIngestBody,
  startWideEvent,
  uuidv7,
  WireError,
} from "@orange-replay/shared";
import { shouldSampleSession } from "@orange-replay/shared/sampling";
import type { EdgeAttrs, IngestAck, ProjectConfig, WideEventOutcome } from "@orange-replay/shared";
import type { AppendArgs } from "../do/contract.ts";
import { setWorkerLoggerVersion, shardDb } from "../env.ts";
import type { Env } from "../env.ts";
import {
  MAX_INGEST_BODY_BYTES,
  ingestPostHeaders,
  ingestPreflightHeaders,
  mapConfigRowToProjectConfig,
  parseProjectConfig,
  readBodyCapped,
  readContentLength,
  sanitizeBatchIndexEvents,
  sha256Hex,
  validateIngestHeaders,
} from "./helpers.ts";
import type { ProjectConfigRow } from "./helpers.ts";

const CONFIG_READ_QUERY =
  "SELECT k.project_id AS projectId, k.active AS active, p.org_id AS orgId, p.retention_days AS retentionDays, p.jurisdiction AS jurisdiction, p.sample_rate AS sampleRate, p.allowed_origins AS allowedOrigins, p.mask_policy_version AS maskPolicyVersion, p.quota_state AS quotaState, o.shard AS shard FROM keys k JOIN projects p ON p.id = k.project_id JOIN orgs o ON o.id = p.org_id WHERE k.key_hash = ?";

export function handleIngest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  setWorkerLoggerVersion(env);

  if (request.method === "OPTIONS") {
    return Promise.resolve(
      loggedIngestEdgeResponse(request, "http.preflight", "success", (requestId) => {
        const headers = ingestPreflightHeaders(request);
        headers.set(HDR_REQUEST_ID, requestId);
        return { requestId, response: new Response(null, { status: 204, headers }) };
      }),
    );
  }

  if (request.method !== "POST") {
    return Promise.resolve(
      loggedIngestEdgeResponse(request, "ingest.rejected", "client_error", (requestId) => {
        const headers = ingestPostHeaders(request);
        headers.set(HDR_REQUEST_ID, requestId);
        return {
          requestId,
          response: jsonResponse({ error: "method not allowed" }, 405, headers),
        };
      }),
    );
  }

  return handleIngestPost(request, env, ctx);
}

async function handleIngestPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const requestId = uuidv7();
  const event = startWideEvent("worker", "ingest.batch", requestId);
  let statusCode = 500;
  let outcome: WideEventOutcome = "server_error";
  let responseHeaders = ingestPostHeaders(request);
  responseHeaders.set(HDR_REQUEST_ID, requestId);

  const finish = <Body>(body: Body, status: number, nextOutcome: WideEventOutcome): Response => {
    statusCode = status;
    outcome = nextOutcome;
    responseHeaders.set(HDR_REQUEST_ID, requestId);
    return jsonResponse(body, status, responseHeaders);
  };

  try {
    const headersResult = validateIngestHeaders(request.headers);
    if (!headersResult.ok) {
      return finish({ error: headersResult.error }, 400, "client_error");
    }

    const { key, sessionId, tab, seq, flags } = headersResult.value;
    let cleanedFlags = flags;
    event.set({ session_id: sessionId, tab, seq, flags: cleanedFlags });

    // Content-Length is optional (proxies may re-chunk requests) but when
    // present it must be sane — and the body read below is size-capped either
    // way, so a chunked upload can never buffer more than the cap.
    const contentLength = readContentLength(request.headers);
    if (contentLength.ok) {
      event.set({ bytes_in: contentLength.value });
      if (contentLength.value > MAX_INGEST_BODY_BYTES) {
        return finish({ error: "ingest body is too large" }, 413, "client_error");
      }
    } else if (contentLength.malformed) {
      return finish({ error: contentLength.error }, 400, "client_error");
    }

    const keyHash = await sha256Hex(key);
    const configResult = await loadProjectConfig(env, ctx, keyHash);
    event.set({ kv_hit: configResult.kvHit });

    const config = configResult.config;
    if (config !== null) {
      responseHeaders = ingestPostHeaders(request, config.allowedOrigins);
      responseHeaders.set(HDR_REQUEST_ID, requestId);
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

    // Server-side sampling re-check (ARCHITECTURE §2): the SDK already makes
    // this deterministic decision client-side; re-deriving it here means a
    // client that ignores sampleRate cannot force ingestion of out-of-sample
    // sessions. Same shared FNV-1a decision, so honest clients never see it.
    if (!shouldSampleSession(sessionId, config.sampleRate)) {
      event.set({ live: false, drop_reason: "sampled_out" });
      return finish(
        { ok: true, live: false, flushMs: SDK_FLUSH_DEFAULT_MS, drop: true } satisfies IngestAck,
        202,
        "dropped",
      );
    }

    const bodyBytes = await readBodyCapped(request.body, MAX_INGEST_BODY_BYTES);
    if (bodyBytes === null) {
      return finish({ error: "ingest body is too large" }, 413, "client_error");
    }
    event.set({ bytes_in: bodyBytes.byteLength });

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

    const sanitized = sanitizeBatchIndexEvents(decoded.index);
    if (sanitized.eventsDropped > 0) {
      event.set({ events_dropped: sanitized.eventsDropped });
    }

    let payload = decoded.payload;
    const payloadSizeError = validatePayloadSize(payload);
    if (payloadSizeError !== null) {
      return finish(payloadSizeError.body, payloadSizeError.status, "client_error");
    }

    if ((flags & FLAG_UNCOMPRESSED) !== 0) {
      payload = await gzipPayload(payload);
      cleanedFlags = flags - FLAG_UNCOMPRESSED;
      event.set({ flags: cleanedFlags });
      const compressedPayloadSizeError = validatePayloadSize(payload);
      if (compressedPayloadSizeError !== null) {
        return finish(
          compressedPayloadSizeError.body,
          compressedPayloadSizeError.status,
          "client_error",
        );
      }
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
      index: sanitized.index,
      payload,
      attrs,
      receivedAt: Date.now(),
    } satisfies AppendArgs);

    if (result.rateLimited === true) {
      event.set({ flags: cleanedFlags, live: result.live });
      return finish({ error: "rate_limited" }, 429, "rate_limited");
    }

    writeTrend(env, config.projectId, attrs.country, payload.byteLength);
    event.set({ flags: cleanedFlags, live: result.live });

    return finish(
      {
        ok: true,
        live: result.live,
        closed: result.closed || undefined,
        flushMs: result.flushMs,
        checkpoint: result.checkpoint || undefined,
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

function loggedIngestEdgeResponse(
  request: Request,
  eventName: "http.preflight" | "ingest.rejected",
  expectedOutcome: WideEventOutcome,
  buildResponse: (requestId: string) => { requestId: string; response: Response },
): Response {
  const requestId = uuidv7();
  const event = startWideEvent("worker", eventName, requestId);
  let statusCode = 500;
  let outcome: WideEventOutcome = "server_error";

  try {
    const built = buildResponse(requestId);
    statusCode = built.response.status;
    outcome = expectedOutcome;
    return built.response;
  } catch (error) {
    event.fail(error);
    throw error;
  } finally {
    event.set({
      route: "/v1/ingest",
      method: request.method,
      status_code: statusCode,
    });
    event.emit(outcome === "server_error" ? outcome : expectedOutcome);
  }
}

function validatePayloadSize(payload: Uint8Array): {
  body: { error: string };
  status: number;
} | null {
  if (payload.byteLength === 0) {
    return { body: { error: "ingest payload is empty" }, status: 400 };
  }

  if (payload.byteLength > MAX_COMPRESSED_BATCH_BYTES) {
    return { body: { error: "ingest payload is too large" }, status: 413 };
  }

  return null;
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
  const userAgent = request.headers.get("user-agent") ?? "";
  const deviceInfo = attrsFromUserAgent(userAgent);

  return {
    ...(cf === undefined
      ? {}
      : {
          country: readString(cf["country"]),
          region: readString(cf["regionCode"]),
          city: readString(cf["city"]),
          asn: readNumber(cf["asn"]),
        }),
    ...deviceInfo,
  };
}

function attrsFromUserAgent(userAgent: string): Pick<EdgeAttrs, "browser" | "os" | "device"> {
  if (userAgent.length === 0) {
    return {};
  }

  return {
    browser: browserFromUserAgent(userAgent),
    os: osFromUserAgent(userAgent),
    device: deviceFromUserAgent(userAgent),
  };
}

function browserFromUserAgent(userAgent: string): string | undefined {
  if (userAgent.includes("Edg/")) return "Edge";
  if (userAgent.includes("Chrome/") || userAgent.includes("CriOS/")) return "Chrome";
  if (userAgent.includes("Firefox/") || userAgent.includes("FxiOS/")) return "Firefox";
  if (userAgent.includes("Safari/")) return "Safari";
  return undefined;
}

function osFromUserAgent(userAgent: string): string | undefined {
  if (userAgent.includes("Windows NT")) return "Windows";
  if (userAgent.includes("Mac OS X")) return "macOS";
  if (userAgent.includes("Android")) return "Android";
  if (userAgent.includes("iPhone") || userAgent.includes("iPad")) return "iOS";
  if (userAgent.includes("Linux")) return "Linux";
  return undefined;
}

function deviceFromUserAgent(userAgent: string): string | undefined {
  if (userAgent.includes("iPad") || userAgent.includes("Tablet")) return "tablet";
  if (
    userAgent.includes("Mobile") ||
    userAgent.includes("Android") ||
    userAgent.includes("iPhone")
  ) {
    return "mobile";
  }
  return "desktop";
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

function jsonResponse(body: unknown, status: number, headers: Headers): Response {
  return Response.json(body, { status, headers });
}
