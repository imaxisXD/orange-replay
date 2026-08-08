import {
  HDR_REQUEST_ID,
  parseSdkHealthReport,
  startWideEvent,
  uuidv7,
  type WideEventOutcome,
} from "@orange-replay/shared";
import { setWorkerLoggerVersion, type Env } from "../env.ts";
import { captureSdkHealthFailure } from "../observability/sentry.ts";
import { attrsFromRequest, browserOriginIsAllowed } from "./edge-attrs.ts";
import {
  ingestPostHeaders,
  ingestPreflightHeaders,
  readBodyCapped,
  sha256Hex,
  validateRecorderKeyHeader,
} from "./helpers.ts";
import { lookupProjectConfig } from "./project-config-lookup.ts";
import { ingestIpRateLimitAllows, ingestRateLimitAllows } from "./rate-limit.ts";
import { jsonResponse } from "./response.ts";

const MAX_SDK_HEALTH_BODY_BYTES = 128;

export async function handleSdkHealth(request: Request, env: Env): Promise<Response> {
  setWorkerLoggerVersion(env);
  const requestId = uuidv7();
  const event = startWideEvent("worker", "sdk.health", requestId);
  let statusCode = 500;
  let outcome: WideEventOutcome = "server_error";
  let responseHeaders = ingestPostHeaders(request);
  responseHeaders.set(HDR_REQUEST_ID, requestId);
  responseHeaders.set("cache-control", "no-store");

  const finish = (body: unknown, status: number, nextOutcome: WideEventOutcome): Response => {
    statusCode = status;
    outcome = nextOutcome;
    if (status === 429) responseHeaders.set("retry-after", "60");
    return jsonResponse(body, status, responseHeaders);
  };

  try {
    if (request.method === "OPTIONS") {
      responseHeaders = ingestPreflightHeaders(request);
      responseHeaders.set(HDR_REQUEST_ID, requestId);
      statusCode = 204;
      outcome = "success";
      return new Response(null, { status: 204, headers: responseHeaders });
    }
    if (request.method !== "POST") {
      return finish({ error: "method not allowed" }, 405, "client_error");
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return finish({ error: "content-type must be application/json" }, 415, "client_error");
    }

    const recorderKey = validateRecorderKeyHeader(request.headers);
    if (!recorderKey.ok) return finish({ error: recorderKey.error }, 400, "client_error");
    if (
      !(await ingestIpRateLimitAllows(env, env.INGEST_LOOKUP_RATE_LIMITER, request, "sdk-health"))
    ) {
      event.set({ rate_limit: "lookup" });
      return finish({ error: "rate_limited" }, 429, "rate_limited");
    }

    const keyHash = await sha256Hex(recorderKey.value);
    const configResult = await lookupProjectConfig(env, keyHash, request, true);
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
    if (
      !(await ingestRateLimitAllows(
        env,
        env.SDK_HEALTH_RATE_LIMITER,
        `sdk-health:${config.projectId}`,
      ))
    ) {
      event.set({ rate_limit: "project" });
      return finish({ error: "rate_limited" }, 429, "rate_limited");
    }

    const body = await readBodyCapped(request.body, MAX_SDK_HEALTH_BODY_BYTES);
    if (body === null) return finish({ error: "health report is too large" }, 413, "client_error");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return finish({ error: "health report must be valid JSON" }, 400, "client_error");
    }
    const report = parseSdkHealthReport(value);
    if (report === null) {
      return finish({ error: "health report has unsupported fields" }, 400, "client_error");
    }

    const device = attrsFromRequest(request);
    event.set({
      health_code: report.code,
      health_protocol_version: report.version,
      browser: device.browser,
      os: device.os,
      device: device.device,
    });
    captureSdkHealthFailure(report.code, device);
    return finish({ ok: true }, 202, "success");
  } catch (error) {
    event.fail(error);
    return finish({ error: "SDK health report failed" }, 500, "server_error");
  } finally {
    event.set({ route: "/v1/sdk-health", method: request.method, status_code: statusCode });
    event.emit(outcome);
  }
}
