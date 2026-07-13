import { HDR_REQUEST_ID, startWideEvent, uuidv7 } from "@orange-replay/shared";
import { setWorkerLoggerVersion, type Env } from "../env.ts";
import { checkAuth, demoRateLimitAllows, projectAuthError } from "./auth.ts";
import { isValidPathId, isValidSegmentName, outcomeForStatus } from "./helpers.ts";
import { jsonError, jsonResponse } from "./http.ts";
import { mintLiveTicket, proxyLiveSession } from "./live-ticket.ts";
import {
  getDemoDiscovery,
  getInstallStatus,
  getProjectConfig,
  getProjectKeys,
  getProjectStats,
  listLiveSessions,
  putProjectConfig,
} from "./project-routes.ts";
import { getManifest, getSegment, listSessions } from "./session-routes.ts";

export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  setWorkerLoggerVersion(env);
  const url = new URL(request.url);
  const requestId = request.headers.get(HDR_REQUEST_ID) ?? uuidv7();
  const route = routeName(url.pathname);
  const wideEvent = startWideEvent("worker", "api.request", requestId);
  let statusCode = 500;

  wideEvent.set({ route });

  try {
    const response = await routeRequest(request, url, env, ctx, wideEvent, requestId);
    statusCode = response.status;
    return response;
  } catch (err) {
    wideEvent.fail(err);
    const response = jsonError("internal_error", 500);
    statusCode = response.status;
    return response;
  } finally {
    wideEvent.set({ status_code: statusCode });
    wideEvent.emit(outcomeForStatus(statusCode));
  }
}

async function routeRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  wideEvent: ReturnType<typeof startWideEvent>,
  requestId: string,
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    return jsonResponse({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/demo") {
    return getDemoDiscovery(request, env, wideEvent);
  }

  const liveMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live$/.exec(url.pathname);
  if (request.method === "GET" && liveMatch) {
    const ids = parseProjectSessionIds(liveMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId, auth: "ticket" });
    return proxyLiveSession(request, url, env, ids.projectId, ids.sessionId, requestId);
  }

  const auth = await checkAuth(request, env, projectIdFromApiPath(url.pathname));
  if (!auth.ok) return jsonError(auth.error, auth.status);
  wideEvent.set({ auth_mode: auth.mode });
  if (auth.mode === "demo" && !(await demoRateLimitAllows(env, request))) {
    wideEvent.set({ rate_limit: "demo" });
    return jsonError("rate_limited", 429);
  }

  const sessionsMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions$/.exec(url.pathname);
  if (request.method === "GET" && sessionsMatch) {
    const projectId = sessionsMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "sessions_list");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return listSessions(url, env, projectId, auth.mode, wideEvent, ctx);
  }

  const statsMatch = /^\/api\/v1\/projects\/([^/]+)\/stats$/.exec(url.pathname);
  if (request.method === "GET" && statsMatch) {
    const projectId = statsMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "project_stats");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return getProjectStats(url, env, ctx, projectId, requestId, wideEvent);
  }

  const projectLiveMatch = /^\/api\/v1\/projects\/([^/]+)\/live$/.exec(url.pathname);
  if (request.method === "GET" && projectLiveMatch) {
    const projectId = projectLiveMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "project_live");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return listLiveSessions(env, projectId, requestId);
  }

  const configMatch = /^\/api\/v1\/projects\/([^/]+)\/config$/.exec(url.pathname);
  if (configMatch) {
    const projectId = configMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "project_config");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    if (request.method === "GET") return getProjectConfig(env, projectId);
    if (request.method === "PUT") return putProjectConfig(request, env, projectId, wideEvent);
  }

  const installStatusMatch = /^\/api\/v1\/projects\/([^/]+)\/install-status$/.exec(url.pathname);
  if (request.method === "GET" && installStatusMatch) {
    const projectId = installStatusMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "install_status");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return getInstallStatus(env, projectId, requestId);
  }

  const keysMatch = /^\/api\/v1\/projects\/([^/]+)\/keys$/.exec(url.pathname);
  if (request.method === "GET" && keysMatch) {
    const projectId = keysMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "project_keys");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return getProjectKeys(env, projectId, wideEvent);
  }

  const manifestMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/manifest$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && manifestMatch) {
    const ids = parseProjectSessionIds(manifestMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, ids.projectId, "manifest");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId });
    return getManifest(env, ids.projectId, ids.sessionId);
  }

  const liveTicketMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live-ticket$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && liveTicketMatch) {
    const ids = parseProjectSessionIds(liveTicketMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, ids.projectId, "live_ticket");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId });
    return mintLiveTicket(env, ids.projectId, ids.sessionId);
  }

  const segmentMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/segments\/(.+)$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && segmentMatch) {
    const ids = parseProjectSessionIds(segmentMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, ids.projectId, "segment");
    if (authError !== null) return authError;

    const name = segmentMatch[3];
    if (!name || !isValidSegmentName(name)) return jsonError("invalid_segment_name", 400);

    wideEvent.set({
      project_id: ids.projectId,
      session_id: ids.sessionId,
      cache_hit: false,
    });
    return getSegment(env, ids.projectId, ids.sessionId, name);
  }

  if (auth.mode === "demo") return jsonError("unauthorized", 401);
  return jsonError("not_found", 404);
}

function parseProjectSessionIds(
  match: RegExpExecArray,
): { ok: true; projectId: string; sessionId: string } | { ok: false } {
  const projectId = match[1];
  const sessionId = match[2];
  if (!projectId || !sessionId || !isValidPathId(projectId) || !isValidPathId(sessionId)) {
    return { ok: false };
  }
  return { ok: true, projectId, sessionId };
}

function projectIdFromApiPath(pathname: string): string | null {
  const match = /^\/api\/v1\/projects\/([^/]+)/.exec(pathname);
  return match?.[1] ?? null;
}

function routeName(pathname: string): string {
  if (pathname === "/api/v1/demo") return "demo_discovery";
  if (pathname === "/api/v1/health") return "health";
  if (/^\/api\/v1\/projects\/[^/]+\/sessions$/.test(pathname)) return "sessions_list";
  if (/^\/api\/v1\/projects\/[^/]+\/stats$/.test(pathname)) return "project_stats";
  if (/^\/api\/v1\/projects\/[^/]+\/live$/.test(pathname)) return "project_live";
  if (/^\/api\/v1\/projects\/[^/]+\/config$/.test(pathname)) return "project_config";
  if (/^\/api\/v1\/projects\/[^/]+\/install-status$/.test(pathname)) {
    return "install_status";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/keys$/.test(pathname)) return "project_keys";
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/manifest$/.test(pathname)) {
    return "manifest";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/live-ticket$/.test(pathname)) {
    return "live_ticket";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/segments\/.+$/.test(pathname)) {
    return "segment";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/live$/.test(pathname)) return "live";
  return "not_found";
}
