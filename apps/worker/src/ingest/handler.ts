import {
  FLAG_UNCOMPRESSED,
  HDR_REQUEST_ID,
  MAX_COMPRESSED_BATCH_BYTES,
  PROJECT_CONFIG_CACHE_TTL_SECONDS,
  PERSISTED_REPLAY_FLAG_MASK,
  SDK_FLUSH_DEFAULT_MS,
  configKvKey,
  decodeIngestBody,
  startWideEvent,
  uuidv7,
  WireError,
} from "@orange-replay/shared";
import { shouldSampleSession } from "@orange-replay/shared/sampling";
import type {
  EdgeAttrs,
  IngestAck,
  ProjectConfig,
  RecorderProjectConfig,
  WideEventOutcome,
} from "@orange-replay/shared";
import { ensureProjectConfigStorage } from "../api/project-config.ts";
import type { AppendArgs } from "../do/contract.ts";
import { isDevTestMode, setWorkerLoggerVersion, shardDb } from "../env.ts";
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
  validateWriteKeyHeader,
} from "./helpers.ts";
import type { ProjectConfigRow } from "./helpers.ts";

const CONFIG_READ_QUERY =
  "SELECT k.project_id AS projectId, k.active AS active, p.org_id AS orgId, p.retention_days AS retentionDays, p.jurisdiction AS jurisdiction, p.sample_rate AS sampleRate, p.allowed_origins AS allowedOrigins, p.mask_policy_version AS maskPolicyVersion, p.mask_rules AS maskRules, p.capture_toggles AS capture, p.quota_state AS quotaState, p.config_version AS version, o.shard AS shard FROM keys k JOIN projects p ON p.id = k.project_id JOIN orgs o ON o.id = p.org_id WHERE k.key_hash = ?";

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

export async function handleRecorderConfig(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  setWorkerLoggerVersion(env);
  const requestId = uuidv7();
  const event = startWideEvent("worker", "recorder.config", requestId);
  let statusCode = 500;
  let outcome: WideEventOutcome = "server_error";
  let responseHeaders = ingestPostHeaders(request);
  responseHeaders.set(HDR_REQUEST_ID, requestId);
  responseHeaders.set("cache-control", "no-store");

  const finish = (body: unknown, status: number, nextOutcome: WideEventOutcome): Response => {
    statusCode = status;
    outcome = nextOutcome;
    if (status === 429) responseHeaders.set("retry-after", "2");
    return jsonResponse(body, status, responseHeaders);
  };

  try {
    if (request.method === "OPTIONS") {
      responseHeaders = ingestPreflightHeaders(request);
      responseHeaders.set("access-control-allow-methods", "GET,OPTIONS");
      responseHeaders.set(HDR_REQUEST_ID, requestId);
      statusCode = 204;
      outcome = "success";
      return new Response(null, { status: 204, headers: responseHeaders });
    }
    if (request.method !== "GET") {
      return finish({ error: "method not allowed" }, 405, "client_error");
    }

    const writeKey = validateWriteKeyHeader(request.headers);
    if (!writeKey.ok) return finish({ error: writeKey.error }, 400, "client_error");

    const keyHash = await sha256Hex(writeKey.value);
    // Unlike the ingest hot path, this public endpoint applies the lookup
    // limiter before the KV read too — the write key is public (demo) and a
    // recorder only fetches config once per page load.
    if (!(await ingestIpRateLimitAllows(env, env.INGEST_LOOKUP_RATE_LIMITER, request, "lookup"))) {
      event.set({ rate_limit: "lookup" });
      return finish({ error: "rate_limited" }, 429, "rate_limited");
    }
    const configResult = await loadProjectConfig(env, ctx, keyHash, request, true);
    event.set({ kv_hit: configResult.kvHit });
    if (configResult.lookupRateLimited) {
      event.set({ rate_limit: "lookup" });
      return finish({ error: "rate_limited" }, 429, "rate_limited");
    }

    const config = configResult.config;
    if (config === null || !config.active) {
      return finish({ error: "unknown or inactive ingest key" }, 401, "client_error");
    }

    responseHeaders = ingestPostHeaders(request, config.allowedOrigins);
    responseHeaders.set(HDR_REQUEST_ID, requestId);
    responseHeaders.set("cache-control", "no-store");
    event.set({ project_id: config.projectId, org_id: config.orgId });
    if (!browserOriginIsAllowed(request, config.allowedOrigins)) {
      return finish({ error: "origin is not allowed" }, 403, "client_error");
    }

    const recorderConfig: RecorderProjectConfig = {
      sampleRate: config.quotaState === "exceeded" ? 0 : config.sampleRate,
      maskPolicyVersion: config.maskPolicyVersion,
      maskRules: config.maskRules ?? [],
      capture: config.capture ?? {
        heatmaps: false,
        console: false,
        network: false,
        canvas: false,
      },
      version: config.version ?? 0,
    };
    return finish(recorderConfig, 200, "success");
  } catch (error) {
    event.fail(error);
    return finish({ error: "recorder config failed" }, 500, "server_error");
  } finally {
    event.set({ route: "/v1/config", method: request.method, status_code: statusCode });
    event.emit(outcome);
  }
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
    if (status === 429) responseHeaders.set("retry-after", "2");
    return jsonResponse(body, status, responseHeaders);
  };

  try {
    const headersResult = validateIngestHeaders(request.headers);
    if (!headersResult.ok) {
      return finish({ error: headersResult.error }, 400, "client_error");
    }

    const { key, sessionId, tab, seq, flags } = headersResult.value;
    const cleanedFlags = flags & PERSISTED_REPLAY_FLAG_MASK;
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
    const configResult = await loadProjectConfig(env, ctx, keyHash, request);
    event.set({ kv_hit: configResult.kvHit });
    if (configResult.lookupRateLimited) {
      event.set({ rate_limit: "lookup" });
      return finish({ error: "rate_limited" }, 429, "rate_limited");
    }

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

    // SDK write keys are public browser credentials. Reject disallowed browser
    // origins before shared project/session limit accounting so copied keys from
    // blocked sites cannot drain legitimate ingest capacity.
    if (!browserOriginIsAllowed(request, config.allowedOrigins)) {
      return finish({ error: "origin is not allowed" }, 403, "client_error");
    }

    if (
      !(await ingestRateLimitAllows(
        env,
        env.INGEST_PROJECT_RATE_LIMITER,
        `project:${config.projectId}:${keyHash}`,
      ))
    ) {
      event.set({ rate_limit: "project" });
      return finish({ error: "rate_limited" }, 429, "rate_limited");
    }

    if (
      seq === 0 &&
      !(await ingestRateLimitAllows(
        env,
        env.INGEST_SESSION_RATE_LIMITER,
        `session-create:${config.projectId}`,
      ))
    ) {
      event.set({ rate_limit: "session" });
      return finish({ error: "rate_limited" }, 429, "rate_limited");
    }

    // Origin is only a browser/CORS policy check; non-browser clients can forge
    // it, so lookup limits, project limits, session limits, quotas, payload
    // caps, and DO caps remain the abuse controls before any write is accepted.
    if (config.quotaState === "exceeded") {
      event.set({ live: false });
      return finish(
        { ok: true, live: false, flushMs: SDK_FLUSH_DEFAULT_MS, drop: true } satisfies IngestAck,
        202,
        "dropped",
      );
    }

    // Sampling is deterministic over a browser-provided session id, so it is an
    // honest-client optimization and compatibility check, not an abuse boundary.
    // Actual cost controls are the rate limiters, quota state, body caps, and
    // Durable Object session caps above/below this branch.
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

async function ingestRateLimitAllows(
  env: Env,
  limiter: Env["INGEST_LOOKUP_RATE_LIMITER"],
  scope: string,
): Promise<boolean> {
  if (limiter === undefined) {
    return isDevTestMode(env);
  }

  const key = await sha256Hex(scope);
  try {
    const result = await limiter.limit({ key });
    return result.success;
  } catch {
    return false;
  }
}

async function ingestIpRateLimitAllows(
  env: Env,
  limiter: Env["INGEST_LOOKUP_RATE_LIMITER"],
  request: Request,
  scope: string,
): Promise<boolean> {
  const source = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  return ingestRateLimitAllows(env, limiter, `${scope}:ip:${source}`);
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
  request: Request,
  requireRecorderFields = false,
): Promise<{ config: ProjectConfig | null; kvHit: boolean; lookupRateLimited: boolean }> {
  const kvConfig = parseProjectConfig(await getCachedProjectConfig(env, keyHash));
  if (kvConfig !== null && (!requireRecorderFields || hasRecorderFields(kvConfig))) {
    return { config: kvConfig, kvHit: true, lookupRateLimited: false };
  }

  if (!(await ingestIpRateLimitAllows(env, env.INGEST_LOOKUP_RATE_LIMITER, request, "lookup"))) {
    return { config: null, kvHit: false, lookupRateLimited: true };
  }

  await ensureProjectConfigStorage(env);
  const row = await shardDb(env, 0)
    .prepare(CONFIG_READ_QUERY)
    .bind(keyHash)
    .first<ProjectConfigRow>();
  const d1Config = mapConfigRowToProjectConfig(row ?? null);
  if (d1Config !== null) {
    ctx.waitUntil(env.CONFIG.put(configKvKey(keyHash), JSON.stringify(d1Config)));
  }

  return { config: d1Config, kvHit: false, lookupRateLimited: false };
}

function hasRecorderFields(config: ProjectConfig): boolean {
  return (
    config.maskRules !== undefined && config.capture !== undefined && config.version !== undefined
  );
}

async function getCachedProjectConfig(env: Env, keyHash: string): Promise<unknown> {
  try {
    return await env.CONFIG.get(configKvKey(keyHash), {
      type: "json",
      cacheTtl: PROJECT_CONFIG_CACHE_TTL_SECONDS,
    });
  } catch {
    return null;
  }
}

function browserOriginIsAllowed(request: Request, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.includes("*")) {
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
