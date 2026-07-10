import { MAX_CONFIG_UPDATE_BODY_BYTES, startWideEvent } from "@orange-replay/shared";
import { listProjectPresence, readProjectInstallStatus } from "../do/presence-client.ts";
import { liveSessionsFromPresenceRows } from "../do/presence-logic.ts";
import type { Env } from "../env.ts";
import { demoRateLimitAllows, readDemoConfig } from "./auth.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "./http.ts";
import {
  parseProjectConfigUpdate,
  readProjectKeys,
  readStoredProjectConfig,
  writeStoredProjectConfig,
} from "./project-config.ts";
import {
  countFilteredLiveSessions,
  parseStatsFilter,
  readCachedFinalizedStats,
  readFinalizedProjectStats,
  statsCacheRequest,
  withLiveNow,
  writeFinalizedStatsCache,
} from "./stats.ts";

export async function getDemoDiscovery(
  request: Request,
  env: Env,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const demo = readDemoConfig(env);
  if (demo === null) return jsonError("not_found", 404);

  wideEvent.set({ project_id: demo.projectId, auth_mode: "demo" });
  if (!(await demoRateLimitAllows(env, request))) {
    wideEvent.set({ rate_limit: "demo" });
    return jsonError("rate_limited", 429);
  }

  return jsonResponse(
    { projectId: demo.projectId, writeKey: demo.writeKey },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}

export async function listLiveSessions(
  env: Env,
  projectId: string,
  requestId: string,
): Promise<Response> {
  const now = Date.now();
  const body = await listProjectPresence(env, projectId, requestId, now);
  if (body === null) return jsonError("presence_unavailable", 503);
  return jsonResponse({
    sessions: liveSessionsFromPresenceRows(body.sessions, now),
  });
}

export async function getProjectConfig(env: Env, projectId: string): Promise<Response> {
  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);
  return jsonResponse(config);
}

export async function putProjectConfig(
  request: Request,
  env: Env,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, MAX_CONFIG_UPDATE_BODY_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);

  const parsed = parseProjectConfigUpdate(body.value);
  if (!parsed.ok) {
    return jsonError(parsed.error, 400);
  }

  const result = await writeStoredProjectConfig(env, projectId, parsed.value);
  if (result.status === "not_found") return jsonError("not_found", 404);
  if (result.status === "version_conflict") return jsonError("config_version_conflict", 409);

  wideEvent.set({ config_version: result.config.version });
  return jsonResponse(result.config);
}

export async function getInstallStatus(
  env: Env,
  projectId: string,
  requestId: string,
): Promise<Response> {
  const status = await readProjectInstallStatus(env, projectId, requestId);
  if (status === null) return jsonError("presence_unavailable", 503);
  return jsonResponse(status);
}

export async function getProjectKeys(
  env: Env,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const keys = await readProjectKeys(env, projectId);
  wideEvent.set({ key_count: keys.length });
  return jsonResponse({ keys });
}

export async function getProjectStats(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  projectId: string,
  requestId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  wideEvent.set({ cache_hit: false });
  const parsed = parseStatsFilter(url.searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const now = Date.now();
  const presencePromise = listProjectPresence(env, projectId, requestId, now);
  const cacheRequest = statsCacheRequest(projectId, parsed.filter);
  let finalized = await readCachedFinalizedStats(cacheRequest);
  const cacheHit = finalized !== null;
  wideEvent.set({ cache_hit: cacheHit });

  if (finalized === null) {
    finalized = await readFinalizedProjectStats(env, projectId, parsed.filter);
    writeFinalizedStatsCache(ctx, cacheRequest, finalized);
  }

  const presence = await presencePromise;
  if (presence === null) return jsonError("presence_unavailable", 503);
  const liveNow = countFilteredLiveSessions(presence.sessions, parsed.filter, now);

  return jsonResponse(withLiveNow(finalized, liveNow), {
    headers: { "cache-control": "private, no-store" },
  });
}
