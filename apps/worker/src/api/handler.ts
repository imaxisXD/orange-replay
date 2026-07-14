import { HDR_REQUEST_ID, startWideEvent, uuidv7 } from "@orange-replay/shared";
import { getAuthMode, isTrustedMutationOrigin } from "../auth/config.ts";
import { handleBetterAuthRequest } from "../auth/server.ts";
import { setWorkerLoggerVersion, type Env } from "../env.ts";
import { bootstrapAccount, getAccount } from "./account-routes.ts";
import { getAdminStats, getAdminUsers } from "./admin-routes.ts";
import {
  checkAuth,
  demoRateLimitAllows,
  globalAdminAuthError,
  isSessionAuth,
  projectAuthError,
  type ApiAuthContext,
} from "./auth.ts";
import { isValidPathId, isValidSegmentName, outcomeForStatus } from "./helpers.ts";
import { jsonError, jsonResponse, withSecurityHeaders } from "./http.ts";
import { mintLiveTicket, proxyLiveSession } from "./live-ticket.ts";
import { getSessionState, listSessionHeads } from "./session-head-routes.ts";
import { createProjectKey, revokeProjectKey } from "./project-keys.ts";
import { getPublicPageSettings, putPublicPageSettings } from "./public-page-settings.ts";
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
import {
  getPublicManifest,
  getPublicPageDataResponse,
  getPublicSegment,
  publicPageRateLimitAllows,
} from "../public-page/data.ts";

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

  if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
    return withSecurityHeaders(await handleBetterAuthRequest(request, env, ctx));
  }

  if (request.method === "GET" && url.pathname === "/api/v1/auth/config") {
    return jsonResponse({ mode: getAuthMode(env) }, { headers: { "cache-control": "no-store" } });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/demo") {
    return getDemoDiscovery(request, env, wideEvent);
  }

  const publicPageMatch = /^\/api\/v1\/public-pages\/([^/]+)$/.exec(url.pathname);
  const publicManifestMatch = /^\/api\/v1\/public-pages\/([^/]+)\/replays\/([^/]+)\/manifest$/.exec(
    url.pathname,
  );
  const publicSegmentMatch =
    /^\/api\/v1\/public-pages\/([^/]+)\/replays\/([^/]+)\/segments\/([^/]+)$/.exec(url.pathname);
  if (
    request.method === "GET" &&
    (publicPageMatch !== null || publicManifestMatch !== null || publicSegmentMatch !== null)
  ) {
    if (!(await publicPageRateLimitAllows(env, request))) {
      wideEvent.set({ rate_limit: "public_page" });
      return jsonError("rate_limited", 429, { "cache-control": "no-store" });
    }
    const publicId = publicPageMatch?.[1] ?? publicManifestMatch?.[1] ?? publicSegmentMatch?.[1];
    if (!publicId || !isValidPathId(publicId)) return jsonError("invalid_path_id", 400);
    wideEvent.set({ public_id: publicId, auth_mode: "public" });

    if (publicPageMatch !== null) {
      return getPublicPageDataResponse(url, env, ctx, publicId, requestId, wideEvent);
    }

    const publicReplayId = publicManifestMatch?.[2] ?? publicSegmentMatch?.[2];
    if (!publicReplayId || !isValidPathId(publicReplayId)) {
      return jsonError("invalid_path_id", 400);
    }
    wideEvent.set({ public_replay_id: publicReplayId });
    if (publicManifestMatch !== null) {
      return getPublicManifest(env, publicId, publicReplayId);
    }

    const segmentName = publicSegmentMatch?.[3];
    if (!segmentName || !isValidSegmentName(segmentName)) {
      return jsonError("invalid_segment_name", 400);
    }
    return getPublicSegment(env, publicId, publicReplayId, segmentName);
  }

  const liveMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live$/.exec(url.pathname);
  if (request.method === "GET" && liveMatch) {
    const ids = parseProjectSessionIds(liveMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId, auth: "ticket" });
    return proxyLiveSession(request, url, env, ids.projectId, ids.sessionId, requestId);
  }

  const auth = await checkAuth(request, env, projectIdFromApiPath(url.pathname), ctx);
  if (!auth.ok) return jsonError(auth.error, auth.status);
  wideEvent.set({ auth_mode: auth.mode });
  if (auth.mode === "demo" && !(await demoRateLimitAllows(env, request))) {
    wideEvent.set({ rate_limit: "demo" });
    return jsonError("rate_limited", 429);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/account") {
    if (!isSessionAuth(auth)) return jsonError("unauthorized", 401);
    wideEvent.set({ user_id: auth.hostedSession.user.id });
    return getAccount(env, auth);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/account/bootstrap") {
    if (!isSessionAuth(auth)) return jsonError("unauthorized", 401);
    const originError = mutationOriginError(request, env, auth);
    if (originError !== null) return originError;
    wideEvent.set({ user_id: auth.hostedSession.user.id });
    return bootstrapAccount(env, auth);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/admin/stats") {
    const authError = globalAdminAuthError(auth);
    if (authError !== null) return authError;
    if (!isSessionAuth(auth)) return jsonError("forbidden", 403);
    wideEvent.set({ user_id: auth.hostedSession.user.id });
    return getAdminStats(env);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/admin/users") {
    const authError = globalAdminAuthError(auth);
    if (authError !== null) return authError;
    if (!isSessionAuth(auth)) return jsonError("forbidden", 403);
    wideEvent.set({ user_id: auth.hostedSession.user.id });
    return getAdminUsers(url, env);
  }

  const sessionsMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions$/.exec(url.pathname);
  if (request.method === "GET" && sessionsMatch) {
    const projectId = sessionsMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "sessions_list");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return authenticatedProjectResponse(
      await listSessions(url, env, projectId, auth.mode, requestId, wideEvent, ctx),
      auth,
    );
  }

  const sessionHeadsMatch = /^\/api\/v1\/projects\/([^/]+)\/session-heads$/.exec(url.pathname);
  if (request.method === "GET" && sessionHeadsMatch) {
    const projectId = sessionHeadsMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "session_heads");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return authenticatedProjectResponse(
      await listSessionHeads(url, env, projectId, requestId),
      auth,
    );
  }

  const statsMatch = /^\/api\/v1\/projects\/([^/]+)\/stats$/.exec(url.pathname);
  if (request.method === "GET" && statsMatch) {
    const projectId = statsMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "project_stats");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return authenticatedProjectResponse(
      await getProjectStats(url, env, ctx, projectId, requestId, wideEvent),
      auth,
    );
  }

  const projectLiveMatch = /^\/api\/v1\/projects\/([^/]+)\/live$/.exec(url.pathname);
  if (request.method === "GET" && projectLiveMatch) {
    const projectId = projectLiveMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "project_live");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return authenticatedProjectResponse(await listLiveSessions(env, projectId, requestId), auth);
  }

  const configMatch = /^\/api\/v1\/projects\/([^/]+)\/config$/.exec(url.pathname);
  if (configMatch) {
    const projectId = configMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const configRoute = request.method === "PUT" ? "project_config_write" : "project_config_read";
    const authError = projectAuthError(auth, projectId, configRoute);
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    if (request.method === "GET") {
      return authenticatedProjectResponse(await getProjectConfig(env, projectId), auth);
    }
    if (request.method === "PUT") {
      const originError = mutationOriginError(request, env, auth);
      if (originError !== null) return originError;
      return authenticatedProjectResponse(
        await putProjectConfig(request, env, projectId, wideEvent),
        auth,
      );
    }
  }

  const installStatusMatch = /^\/api\/v1\/projects\/([^/]+)\/install-status$/.exec(url.pathname);
  if (request.method === "GET" && installStatusMatch) {
    const projectId = installStatusMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "install_status");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    return authenticatedProjectResponse(await getInstallStatus(env, projectId, requestId), auth);
  }

  const publicPageSettingsMatch = /^\/api\/v1\/projects\/([^/]+)\/public-page$/.exec(url.pathname);
  if ((request.method === "GET" || request.method === "PUT") && publicPageSettingsMatch) {
    const projectId = publicPageSettingsMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const publicPageRoute = request.method === "PUT" ? "public_page_write" : "public_page_read";
    const authError = projectAuthError(auth, projectId, publicPageRoute);
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    if (request.method === "GET") {
      return authenticatedProjectResponse(await getPublicPageSettings(url, env, projectId), auth);
    }
    const originError = mutationOriginError(request, env, auth);
    if (originError !== null) return originError;
    return authenticatedProjectResponse(
      await putPublicPageSettings(request, url, env, projectId, wideEvent),
      auth,
    );
  }

  const keysMatch = /^\/api\/v1\/projects\/([^/]+)\/keys$/.exec(url.pathname);
  if ((request.method === "GET" || request.method === "POST") && keysMatch) {
    const projectId = keysMatch[1];
    if (!projectId || !isValidPathId(projectId)) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, projectId, "project_keys");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: projectId });
    if (request.method === "GET") {
      return authenticatedProjectResponse(await getProjectKeys(env, projectId, wideEvent), auth);
    }
    const originError = mutationOriginError(request, env, auth);
    if (originError !== null) return originError;
    return authenticatedProjectResponse(
      await createProjectKey(request, env, projectId, isSessionAuth(auth) ? auth : null),
      auth,
    );
  }

  const keyMatch = /^\/api\/v1\/projects\/([^/]+)\/keys\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && keyMatch) {
    const projectId = keyMatch[1];
    const keyId = keyMatch[2];
    if (!projectId || !keyId || !isValidPathId(projectId) || !isValidPathId(keyId)) {
      return jsonError("invalid_path_id", 400);
    }
    const authError = projectAuthError(auth, projectId, "project_keys");
    if (authError !== null) return authError;
    const originError = mutationOriginError(request, env, auth);
    if (originError !== null) return originError;
    wideEvent.set({ project_id: projectId, key_id: keyId });
    return authenticatedProjectResponse(
      await revokeProjectKey(env, projectId, keyId, isSessionAuth(auth) ? auth : null),
      auth,
    );
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
    return authenticatedProjectResponse(await getManifest(env, ids.projectId, ids.sessionId), auth);
  }

  const sessionStateMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/state$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && sessionStateMatch) {
    const ids = parseProjectSessionIds(sessionStateMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, ids.projectId, "session_state");
    if (authError !== null) return authError;
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId });
    return authenticatedProjectResponse(
      await getSessionState(env, ids.projectId, ids.sessionId, requestId),
      auth,
    );
  }

  const liveTicketMatch = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live-ticket$/.exec(
    url.pathname,
  );
  if (request.method === "POST" && liveTicketMatch) {
    const ids = parseProjectSessionIds(liveTicketMatch);
    if (!ids.ok) return jsonError("invalid_path_id", 400);
    const authError = projectAuthError(auth, ids.projectId, "live_ticket");
    if (authError !== null) return authError;
    const originError = mutationOriginError(request, env, auth);
    if (originError !== null) return originError;
    wideEvent.set({ project_id: ids.projectId, session_id: ids.sessionId });
    return authenticatedProjectResponse(
      await mintLiveTicket(env, ids.projectId, ids.sessionId),
      auth,
    );
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
    return authenticatedProjectResponse(
      await getSegment(env, ids.projectId, ids.sessionId, name),
      auth,
    );
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
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return "better_auth";
  if (pathname === "/api/v1/auth/config") return "auth_config";
  if (pathname === "/api/v1/account") return "account";
  if (pathname === "/api/v1/account/bootstrap") return "account_bootstrap";
  if (pathname === "/api/v1/admin/stats") return "admin_stats";
  if (pathname === "/api/v1/admin/users") return "admin_users";
  if (pathname === "/api/v1/demo") return "demo_discovery";
  if (pathname === "/api/v1/health") return "health";
  if (/^\/api\/v1\/public-pages\/[^/]+$/.test(pathname)) return "public_page_data";
  if (/^\/api\/v1\/public-pages\/[^/]+\/replays\/[^/]+\/manifest$/.test(pathname)) {
    return "public_manifest";
  }
  if (/^\/api\/v1\/public-pages\/[^/]+\/replays\/[^/]+\/segments\/[^/]+$/.test(pathname)) {
    return "public_segment";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions$/.test(pathname)) return "sessions_list";
  if (/^\/api\/v1\/projects\/[^/]+\/session-heads$/.test(pathname)) return "session_heads";
  if (/^\/api\/v1\/projects\/[^/]+\/stats$/.test(pathname)) return "project_stats";
  if (/^\/api\/v1\/projects\/[^/]+\/live$/.test(pathname)) return "project_live";
  if (/^\/api\/v1\/projects\/[^/]+\/config$/.test(pathname)) return "project_config";
  if (/^\/api\/v1\/projects\/[^/]+\/install-status$/.test(pathname)) {
    return "install_status";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/public-page$/.test(pathname)) {
    return "public_page_settings";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/keys$/.test(pathname)) return "project_keys";
  if (/^\/api\/v1\/projects\/[^/]+\/keys\/[^/]+$/.test(pathname)) {
    return "project_key";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/manifest$/.test(pathname)) {
    return "manifest";
  }
  if (/^\/api\/v1\/projects\/[^/]+\/sessions\/[^/]+\/state$/.test(pathname)) {
    return "session_state";
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

function mutationOriginError(request: Request, env: Env, auth: ApiAuthContext): Response | null {
  if (auth.mode !== "session") return null;
  return isTrustedMutationOrigin(request, env) ? null : jsonError("untrusted_origin", 403);
}

function authenticatedProjectResponse(response: Response, auth: ApiAuthContext): Response {
  if (auth.mode !== "session") return response;

  const headers = new Headers(response.headers);
  const vary = new Set(
    (headers.get("vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  vary.add("Authorization");
  vary.add("Cookie");
  headers.set("vary", [...vary].join(", "));

  const cacheControl = headers.get("cache-control");
  if (cacheControl === null) {
    headers.set("cache-control", "private, no-store");
  } else if (cacheControl.includes("public")) {
    headers.set("cache-control", cacheControl.replace("public", "private"));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
