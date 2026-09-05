import {
  HDR_REQUEST_ID,
  startWideEvent,
  uuidv7,
  type RecorderProjectConfig,
  type WideEventOutcome,
} from "@orange-replay/shared";
import { setWorkerLoggerVersion, type Env } from "../env.ts";
import { browserOriginIsAllowed } from "./edge-attrs.ts";
import {
  ingestPostHeaders,
  ingestPreflightHeaders,
  sha256Hex,
  validateRecorderKeyHeader,
} from "./helpers.ts";
import { lookupProjectConfig } from "./project-config-lookup.ts";
import { ingestIpRateLimitAllows } from "./rate-limit.ts";
import { jsonResponse } from "./response.ts";

export async function handleRecorderConfig(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
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

    const recorderKey = validateRecorderKeyHeader(request.headers);
    if (!recorderKey.ok) return finish({ error: recorderKey.error }, 400, "client_error");

    const keyHash = await sha256Hex(recorderKey.value);
    // Unlike the ingest hot path, this public endpoint applies the lookup
    // limiter before the KV read too — the recorder key is public (demo) and a
    // recorder only fetches config once per page load.
    if (!(await ingestIpRateLimitAllows(env, env.INGEST_LOOKUP_RATE_LIMITER, request, "lookup"))) {
      event.set({ rate_limit: "lookup" });
      return finish({ error: "rate_limited" }, 429, "rate_limited");
    }
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

    const recorderConfig: RecorderProjectConfig = {
      domMaskingVersion: 1,
      recorderUrl: await recorderAssetUrl(request, env),
      projectId: config.projectId,
      sessionScope: config.projectId,
      ...(config.sessionCookieDomain === undefined
        ? {}
        : { sessionCookieDomain: config.sessionCookieDomain }),
      ...(config.websiteId === undefined ? {} : { websiteId: config.websiteId }),
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

async function recorderAssetUrl(request: Request, env: Env): Promise<string> {
  const stableUrl = new URL("/or-recorder.js", request.url).toString();
  if (env.ASSETS === undefined) return stableUrl;

  try {
    const manifestUrl = new URL("/or-recorder-manifest.json", request.url);
    const response = await env.ASSETS.fetch(new Request(manifestUrl));
    if (!response.ok) return stableUrl;
    const value = (await response.json()) as { file?: unknown };
    if (typeof value.file !== "string" || !/^or-recorder\.[a-f0-9]{16}\.js$/.test(value.file)) {
      return stableUrl;
    }
    return new URL(`/${value.file}`, request.url).toString();
  } catch {
    return stableUrl;
  }
}
