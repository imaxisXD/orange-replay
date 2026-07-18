import {
  MAX_CONFIG_UPDATE_BODY_BYTES,
  startWideEvent,
  type FinalizedProjectStatsResponse,
  type LiveSessionsResponse,
  type ProjectStatsResponse,
  type ProjectKeysResponse,
} from "@orange-replay/shared";
import { projectConfigUpdateSchema } from "@orange-replay/shared/project-config-update";
import { readFinalizedStats } from "../analytics/finalized-read.ts";
import { listProjectPresence, readProjectInstallStatus } from "../do/presence-client.ts";
import { liveSessionsFromPresenceRows } from "../do/presence-logic.ts";
import type { Env } from "../env.ts";
import { saveProjectConfig } from "../project-config/delivery.ts";
import { readStoredProjectConfig } from "../project-config/storage.ts";
import { demoRateLimitAllows, readDemoConfig } from "./auth.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "../http.ts";
import { getProjectKeys as readProjectKeys } from "./project-keys.ts";
import { countFilteredLiveSessions, parseStatsFilter, withLiveNow } from "../analytics/d1-stats.ts";

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
  const response = {
    sessions: liveSessionsFromPresenceRows(body.sessions, now),
    truncated: body.truncated,
  } satisfies LiveSessionsResponse;
  return jsonResponse(response);
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

  const parsed = projectConfigUpdateSchema.safeParse(body.value);
  if (!parsed.success) return jsonError("invalid_project_config", 400);

  const result = await saveProjectConfig(env, projectId, parsed.data);
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
  let keys;
  try {
    keys = await readProjectKeys(env, projectId);
  } catch {
    return jsonError("key_cache_unavailable", 503);
  }
  wideEvent.set({ key_count: keys.length });
  const response = { keys } satisfies ProjectKeysResponse;
  return jsonResponse(response, { headers: { "cache-control": "private, no-store" } });
}

export async function getProjectStats(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  projectId: string,
  requestId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
  includeLive = true,
): Promise<Response> {
  wideEvent.set({ cache_hit: false });
  const parsed = parseStatsFilter(url.searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const now = Date.now();
  const [finalizedRead, presence] = await Promise.all([
    readFinalizedStats({
      env,
      projectId,
      requestedFilter: parsed.filter,
      requestId,
      wideEvent,
      ctx,
      now,
    }),
    includeLive ? listProjectPresence(env, projectId, requestId, now) : Promise.resolve(null),
  ]);
  if (!finalizedRead.ok) return jsonError(finalizedRead.error, finalizedRead.status);
  if (includeLive && presence === null) return jsonError("presence_unavailable", 503);

  const responseFields = {
    ...(finalizedRead.warehouseVersion === undefined
      ? {}
      : { warehouseVersion: finalizedRead.warehouseVersion }),
    analyticsState: finalizedRead.analyticsState,
  };

  if (!includeLive) {
    const response = {
      ...finalizedRead.value,
      ...responseFields,
    } satisfies FinalizedProjectStatsResponse;
    return jsonResponse(response, { headers: { "cache-control": "private, no-store" } });
  }

  if (presence === null) return jsonError("presence_unavailable", 503);
  const liveNow = countFilteredLiveSessions(presence.sessions, finalizedRead.value.filter, now);

  const response = {
    ...withLiveNow(finalizedRead.value, liveNow),
    ...responseFields,
  } satisfies ProjectStatsResponse;
  return jsonResponse(response, {
    headers: { "cache-control": "private, no-store" },
  });
}
