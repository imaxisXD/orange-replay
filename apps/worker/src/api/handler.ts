import { HDR_REQUEST_ID, startWideEvent, uuidv7 } from "@orange-replay/shared";
import { getAuthMode, isTrustedMutationOrigin } from "../auth/config.ts";
import { handleBetterAuthRequest } from "../auth/server.ts";
import { checkAnalyticsReadRateLimit } from "../analytics/read-rate-limit.ts";
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
import {
  matchDashboardRequest,
  type AuthedPlan,
  type KeyIds,
  type ProjectIds,
  type ProjectParams,
  type ProjectRoutePlan,
  type PublicPageIds,
  type PublicPageParams,
  type PublicPagePlan,
  type SessionIds,
} from "./dashboard-request-policy.ts";
import { outcomeForStatus } from "./helpers.ts";
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

type WideEvent = ReturnType<typeof startWideEvent>;

export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  setWorkerLoggerVersion(env);
  const url = new URL(request.url);
  const requestId = request.headers.get(HDR_REQUEST_ID) ?? uuidv7();
  const plan = matchDashboardRequest(request.method, url.pathname);
  const wideEvent = startWideEvent("worker", "api.request", requestId);
  let statusCode = 500;

  wideEvent.set({ route: plan.routeName });

  try {
    const response = await routeRequest(request, url, env, ctx, wideEvent, requestId, plan);
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
  wideEvent: WideEvent,
  requestId: string,
  plan: ReturnType<typeof matchDashboardRequest>,
): Promise<Response> {
  switch (plan.kind) {
    case "better_auth":
      return withSecurityHeaders(await handleBetterAuthRequest(request, env, ctx));
    case "public": {
      if (plan.action === "health") return jsonResponse({ ok: true });
      if (plan.action === "auth_config") {
        return jsonResponse(
          { mode: getAuthMode(env) },
          { headers: { "cache-control": "no-store" } },
        );
      }
      return getDemoDiscovery(request, env, wideEvent);
    }
    case "public_page":
      return handlePublicPageRequest(request, url, env, ctx, wideEvent, requestId, plan);
    case "ticket_live": {
      if (!plan.params.ok) return jsonError("invalid_path_id", 400);
      const { projectId, sessionId } = plan.params.ids;
      wideEvent.set({ project_id: projectId, session_id: sessionId, auth: "ticket" });
      return proxyLiveSession(request, url, env, projectId, sessionId, requestId);
    }
    case "authed":
      return handleAuthedRequest(request, url, env, ctx, wideEvent, requestId, plan);
  }
}

async function handleAuthedRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  wideEvent: WideEvent,
  requestId: string,
  plan: AuthedPlan,
): Promise<Response> {
  const auth = await checkAuth(request, env, plan.projectIdForAuth, ctx);
  if (!auth.ok) return jsonError(auth.error, auth.status);
  wideEvent.set({ auth_mode: auth.mode });
  if (auth.mode === "demo" && !(await demoRateLimitAllows(env, request))) {
    wideEvent.set({ rate_limit: "demo" });
    return jsonError("rate_limited", 429);
  }

  const route = plan.route;

  if (route.access === "authenticated") {
    return finalDashboardRouteError(auth);
  }

  if (route.access === "session") {
    if (!isSessionAuth(auth)) return jsonError("unauthorized", 401);
    wideEvent.set({ user_id: auth.hostedSession.user.id });
    if (route.mutationOrigin) {
      const originError = mutationOriginError(request, env, auth);
      if (originError !== null) return originError;
    }
    return route.action === "account" ? getAccount(env, auth) : bootstrapAccount(env, auth);
  }

  if (route.access === "global_admin") {
    const adminError = globalAdminAuthError(auth);
    if (adminError !== null) return adminError;
    if (!isSessionAuth(auth)) return jsonError("forbidden", 403);
    wideEvent.set({ user_id: auth.hostedSession.user.id });
    return route.action === "admin_stats" ? getAdminStats(env) : getAdminUsers(url, env);
  }

  return handleProjectRoute(request, url, env, ctx, wideEvent, requestId, auth, route);
}

async function handleProjectRoute(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  wideEvent: WideEvent,
  requestId: string,
  auth: ApiAuthContext,
  route: ProjectRoutePlan,
): Promise<Response> {
  const params = route.params;
  if (!params.ok) {
    if (params.error === "invalid_path_id") return jsonError("invalid_path_id", 400);
    // Project access is checked before an invalid segment name is rejected.
    const authError = projectAuthError(auth, params.ids.projectId, route.route);
    if (authError !== null) return authError;
    return jsonError("invalid_segment_name", 400);
  }

  const authError = projectAuthError(auth, params.ids.projectId, route.route);
  if (authError !== null) return authError;

  if (route.sessionAuthRequired && !isSessionAuth(auth)) {
    return jsonError("unauthorized", 401);
  }

  if (route.analyticsReadLimit) {
    const limited = await analyticsReadRateLimitError(env, auth, params.ids.projectId, wideEvent);
    if (limited !== null) return limited;
  }

  wideEvent.set(projectLogFields(params.ids));

  if (route.mutationOrigin) {
    const originError = mutationOriginError(request, env, auth);
    if (originError !== null) return originError;
  }

  const response = await executeProjectRoute(
    request,
    url,
    env,
    ctx,
    wideEvent,
    requestId,
    auth,
    route,
  );
  return route.authenticatedResponse ? authenticatedProjectResponse(response, auth) : response;
}

async function executeProjectRoute(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  wideEvent: WideEvent,
  requestId: string,
  auth: ApiAuthContext,
  route: ProjectRoutePlan,
): Promise<Response> {
  switch (route.action) {
    case "sessions_list": {
      const { projectId } = grantedIds(route.params);
      return listSessions(url, env, projectId, auth.mode, requestId, wideEvent, ctx);
    }
    case "session_heads": {
      const { projectId } = grantedIds(route.params);
      return listSessionHeads(url, env, projectId, requestId);
    }
    case "project_stats": {
      const { projectId } = grantedIds(route.params);
      return getProjectStats(url, env, ctx, projectId, requestId, wideEvent);
    }
    case "project_live": {
      const { projectId } = grantedIds(route.params);
      return listLiveSessions(env, projectId, requestId);
    }
    case "project_config_read": {
      const { projectId } = grantedIds(route.params);
      return getProjectConfig(env, projectId);
    }
    case "project_config_write": {
      const { projectId } = grantedIds(route.params);
      return putProjectConfig(request, env, projectId, wideEvent);
    }
    case "project_config_method_not_allowed":
      return finalDashboardRouteError(auth);
    case "install_status": {
      const { projectId } = grantedIds(route.params);
      return getInstallStatus(env, projectId, requestId);
    }
    case "public_page_read": {
      const { projectId } = grantedIds(route.params);
      return getPublicPageSettings(url, env, projectId);
    }
    case "public_page_write": {
      const { projectId } = grantedIds(route.params);
      return putPublicPageSettings(request, url, env, projectId, wideEvent);
    }
    case "project_keys_read": {
      const { projectId } = grantedIds(route.params);
      return getProjectKeys(env, projectId, wideEvent);
    }
    case "project_keys_create": {
      const { projectId } = grantedIds(route.params);
      if (!isSessionAuth(auth)) return jsonError("unauthorized", 401);
      return createProjectKey(request, env, projectId, auth);
    }
    case "project_key_revoke": {
      const { projectId, keyId } = grantedIds(route.params);
      if (!isSessionAuth(auth)) return jsonError("unauthorized", 401);
      return revokeProjectKey(env, projectId, keyId, auth);
    }
    case "manifest": {
      const { projectId, sessionId } = grantedIds(route.params);
      return getManifest(env, projectId, sessionId);
    }
    case "session_state": {
      const { projectId, sessionId } = grantedIds(route.params);
      return getSessionState(env, projectId, sessionId, requestId);
    }
    case "live_ticket": {
      const { projectId, sessionId } = grantedIds(route.params);
      return mintLiveTicket(env, projectId, sessionId, liveViewerIdentity(request, auth));
    }
    case "segment": {
      const { projectId, sessionId, segmentName } = grantedIds(route.params);
      wideEvent.set({ cache_hit: false });
      return getSegment(env, projectId, sessionId, segmentName);
    }
  }
}

async function handlePublicPageRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  wideEvent: WideEvent,
  requestId: string,
  plan: PublicPagePlan,
): Promise<Response> {
  if (!(await publicPageRateLimitAllows(env, request))) {
    wideEvent.set({ rate_limit: "public_page" });
    return jsonError("rate_limited", 429, { "cache-control": "no-store" });
  }

  const params = plan.params;
  if (!params.ok) {
    if (params.logged.publicId !== undefined) {
      wideEvent.set({ public_id: params.logged.publicId, auth_mode: "public" });
    }
    if (params.logged.publicReplayId !== undefined) {
      wideEvent.set({ public_replay_id: params.logged.publicReplayId });
    }
    return jsonError(params.error, 400);
  }

  wideEvent.set({ public_id: params.ids.publicId, auth_mode: "public" });

  switch (plan.action) {
    case "page_data": {
      const { publicId } = grantedPublicIds(plan.params);
      return getPublicPageDataResponse(url, env, ctx, publicId, requestId, wideEvent);
    }
    case "manifest": {
      const { publicId, publicReplayId } = grantedPublicIds(plan.params);
      wideEvent.set({ public_replay_id: publicReplayId });
      return getPublicManifest(env, publicId, publicReplayId);
    }
    case "segment": {
      const { publicId, publicReplayId, segmentName } = grantedPublicIds(plan.params);
      wideEvent.set({ public_replay_id: publicReplayId });
      return getPublicSegment(env, publicId, publicReplayId, segmentName);
    }
  }
}

function grantedIds<Ids extends ProjectIds>(params: ProjectParams<Ids>): Ids {
  if (!params.ok) throw new Error("Project route executed without validated ids.");
  return params.ids;
}

function grantedPublicIds<Ids extends PublicPageIds>(params: PublicPageParams<Ids>): Ids {
  if (!params.ok) throw new Error("Public page route executed without validated ids.");
  return params.ids;
}

function projectLogFields(ids: ProjectIds & Partial<SessionIds & KeyIds>): Record<string, string> {
  const fields: Record<string, string> = { project_id: ids.projectId };
  if (ids.sessionId !== undefined) fields.session_id = ids.sessionId;
  if (ids.keyId !== undefined) fields.key_id = ids.keyId;
  return fields;
}

function finalDashboardRouteError(auth: ApiAuthContext): Response {
  return auth.mode === "demo" ? jsonError("unauthorized", 401) : jsonError("not_found", 404);
}

function liveViewerIdentity(request: Request, auth: ApiAuthContext): string {
  if (auth.mode === "session") return `user:${auth.hostedSession.user.id}`;
  return `demo:${request.headers.get("cf-connecting-ip")?.trim() || "unknown"}`;
}

async function analyticsReadRateLimitError(
  env: Env,
  auth: ApiAuthContext,
  projectId: string,
  wideEvent: WideEvent,
): Promise<Response | null> {
  const result = await checkAnalyticsReadRateLimit(
    env,
    auth.mode === "session" ? `user:${auth.hostedSession.user.id}` : null,
    projectId,
  );
  if (result.allowed) return null;

  wideEvent.set({ rate_limit: `analytics_${result.scope}` });
  return jsonError("rate_limited", 429, { "retry-after": "60" });
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
