import {
  FLAG_UNCOMPRESSED,
  HDR_REQUEST_ID,
  PERSISTED_REPLAY_FLAG_MASK,
  SDK_FLUSH_DEFAULT_MS,
  decodeIngestBody,
  startWideEvent,
  uuidv7,
  WireError,
} from "@orange-replay/shared";
import { shouldSampleSession } from "@orange-replay/shared/sampling";
import type { IngestAck, WideEventOutcome } from "@orange-replay/shared";
import type { AppendArgs } from "../do/contract.ts";
import { setWorkerLoggerVersion } from "../env.ts";
import type { Env } from "../env.ts";
import { attrsFromRequest, browserOriginIsAllowed } from "./edge-attrs.ts";
import {
  MAX_INGEST_BODY_BYTES,
  ingestPostHeaders,
  ingestPreflightHeaders,
  readBodyCapped,
  readContentLength,
  sanitizeBatchIndexEvents,
  sha256Hex,
  validateIngestHeaders,
} from "./helpers.ts";
import { gzipPayload, indexMismatchError, validatePayloadSize } from "./payload.ts";
import { lookupProjectConfig } from "./project-config-lookup.ts";
import { ingestRateLimitAllows } from "./rate-limit.ts";
import { ingestAckForAppendResult, jsonResponse } from "./response.ts";

export { handleRecorderConfig } from "./recorder-config.ts";

export function handleIngest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
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

  return handleIngestPost(request, env);
}

async function handleIngestPost(request: Request, env: Env): Promise<Response> {
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
    const configResult = await lookupProjectConfig(env, keyHash, request);
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

    const ack = ingestAckForAppendResult(result);
    if (result.drop === true) {
      event.set({ flags: cleanedFlags, live: result.live, drop_reason: "session_cap" });
      return finish(ack, 202, "dropped");
    }

    event.set({ flags: cleanedFlags, live: result.live });

    return finish(ack, 200, "success");
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
