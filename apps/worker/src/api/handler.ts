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
import { matchDashboardRequest, type DashboardRequestPolicy } from "./dashboard-request-policy.ts";
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

export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  setWorkerLoggerVersion(env);
  const url = new URL(request.url);
  const requestId = request.headers.get(HDR_REQUEST_ID) ?? uuidv7();
  const requestPolicy = matchDashboardRequest(request.method, url.pathname);
  const wideEvent = startWideEvent("worker", "api.request", requestId);
  let statusCode = 500;

  wideEvent.set({ route: requestPolicy.routeName });

  try {
    const response = await routeRequest(
      request,
      url,
      env,
      ctx,
      wideEvent,
      requestId,
      requestPolicy,
    );
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
  requestPolicy: DashboardRequestPolicy,
): Promise<Response> {
  if (requestPolicy.authentication === "better_auth") {
    return applyResponsePolicy(await handleBetterAuthRequest(request, env, ctx), requestPolicy);
  }

  if (requestPolicy.authentication === "ticket") {
    const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
    const sessionId = requiredRouteValue(requestPolicy.sessionId, "session id");
    if (!requestPolicy.projectIdValid || !requestPolicy.sessionIdValid) {
      return jsonError("invalid_path_id", 400);
    }
    wideEvent.set({ project_id: projectId, session_id: sessionId, auth: "ticket" });
    return proxyLiveSession(request, url, env, projectId, sessionId, requestId);
  }

  if (requestPolicy.authentication === "public") {
    if (requestPolicy.action === "health") {
      return jsonResponse({ ok: true });
    }
    if (requestPolicy.action === "auth_config") {
      return jsonResponse({ mode: getAuthMode(env) }, { headers: { "cache-control": "no-store" } });
    }
    if (requestPolicy.action === "demo_discovery") {
      return getDemoDiscovery(request, env, wideEvent);
    }
    return handlePublicPageRequest(request, url, env, ctx, wideEvent, requestId, requestPolicy);
  }

  const auth = await checkAuth(request, env, requestPolicy.projectIdForAuth, ctx);
  if (!auth.ok) return jsonError(auth.error, auth.status);
  wideEvent.set({ auth_mode: auth.mode });
  if (
    requestPolicy.demoRateLimit &&
    auth.mode === "demo" &&
    !(await demoRateLimitAllows(env, request))
  ) {
    wideEvent.set({ rate_limit: "demo" });
    return jsonError("rate_limited", 429);
  }

  const accessError = dashboardAccessError(requestPolicy, auth);
  if (accessError !== null) return accessError;

  if (requestPolicy.handlerRateLimit === "analytics_read") {
    const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
    const rateLimitError = await analyticsReadRateLimitError(env, auth, projectId, wideEvent);
    if (rateLimitError !== null) return rateLimitError;
  }

  switch (requestPolicy.action) {
    case "account": {
      if (!isSessionAuth(auth)) return jsonError("unauthorized", 401);
      wideEvent.set({ user_id: auth.hostedSession.user.id });
      return getAccount(env, auth);
    }
    case "account_bootstrap": {
      if (!isSessionAuth(auth)) return jsonError("unauthorized", 401);
      const originError = policyMutationOriginError(requestPolicy, request, env, auth);
      if (originError !== null) return originError;
      wideEvent.set({ user_id: auth.hostedSession.user.id });
      return bootstrapAccount(env, auth);
    }
    case "admin_stats": {
      if (!isSessionAuth(auth)) return jsonError("forbidden", 403);
      wideEvent.set({ user_id: auth.hostedSession.user.id });
      return getAdminStats(env);
    }
    case "admin_users": {
      if (!isSessionAuth(auth)) return jsonError("forbidden", 403);
      wideEvent.set({ user_id: auth.hostedSession.user.id });
      return getAdminUsers(url, env);
    }
    case "sessions_list": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      return applyResponsePolicy(
        await listSessions(url, env, projectId, auth.mode, requestId, wideEvent, ctx),
        requestPolicy,
        auth,
      );
    }
    case "session_heads": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      return applyResponsePolicy(
        await listSessionHeads(url, env, projectId, requestId),
        requestPolicy,
        auth,
      );
    }
    case "project_stats": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      return applyResponsePolicy(
        await getProjectStats(url, env, ctx, projectId, requestId, wideEvent),
        requestPolicy,
        auth,
      );
    }
    case "project_live": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      return applyResponsePolicy(
        await listLiveSessions(env, projectId, requestId),
        requestPolicy,
        auth,
      );
    }
    case "project_config_read": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      return applyResponsePolicy(await getProjectConfig(env, projectId), requestPolicy, auth);
    }
    case "project_config_write": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      const originError = policyMutationOriginError(requestPolicy, request, env, auth);
      if (originError !== null) return originError;
      return applyResponsePolicy(
        await putProjectConfig(request, env, projectId, wideEvent),
        requestPolicy,
        auth,
      );
    }
    case "project_config_method_not_allowed": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      return finalDashboardRouteError(auth);
    }
    case "install_status": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      return applyResponsePolicy(
        await getInstallStatus(env, projectId, requestId),
        requestPolicy,
        auth,
      );
    }
    case "public_page_read": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      return applyResponsePolicy(
        await getPublicPageSettings(url, env, projectId),
        requestPolicy,
        auth,
      );
    }
    case "public_page_write": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      const originError = policyMutationOriginError(requestPolicy, request, env, auth);
      if (originError !== null) return originError;
      return applyResponsePolicy(
        await putPublicPageSettings(request, url, env, projectId, wideEvent),
        requestPolicy,
        auth,
      );
    }
    case "project_keys_read": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      wideEvent.set({ project_id: projectId });
      return applyResponsePolicy(
        await getProjectKeys(env, projectId, wideEvent),
        requestPolicy,
        auth,
      );
    }
    case "project_keys_create": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      if (!isSessionAuth(auth)) return jsonError("unauthorized", 401);
      wideEvent.set({ project_id: projectId });
      const originError = policyMutationOriginError(requestPolicy, request, env, auth);
      if (originError !== null) return originError;
      return applyResponsePolicy(
        await createProjectKey(request, env, projectId, auth),
        requestPolicy,
        auth,
      );
    }
    case "project_key_revoke": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      const keyId = requiredRouteValue(requestPolicy.keyId, "key id");
      if (!isSessionAuth(auth)) return jsonError("unauthorized", 401);
      const originError = policyMutationOriginError(requestPolicy, request, env, auth);
      if (originError !== null) return originError;
      wideEvent.set({ project_id: projectId, key_id: keyId });
      return applyResponsePolicy(
        await revokeProjectKey(env, projectId, keyId, auth),
        requestPolicy,
        auth,
      );
    }
    case "manifest": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      const sessionId = requiredRouteValue(requestPolicy.sessionId, "session id");
      wideEvent.set({ project_id: projectId, session_id: sessionId });
      return applyResponsePolicy(await getManifest(env, projectId, sessionId), requestPolicy, auth);
    }
    case "session_state": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      const sessionId = requiredRouteValue(requestPolicy.sessionId, "session id");
      wideEvent.set({ project_id: projectId, session_id: sessionId });
      return applyResponsePolicy(
        await getSessionState(env, projectId, sessionId, requestId),
        requestPolicy,
        auth,
      );
    }
    case "live_ticket": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      const sessionId = requiredRouteValue(requestPolicy.sessionId, "session id");
      const originError = policyMutationOriginError(requestPolicy, request, env, auth);
      if (originError !== null) return originError;
      wideEvent.set({ project_id: projectId, session_id: sessionId });
      return applyResponsePolicy(
        await mintLiveTicket(env, projectId, sessionId, liveViewerIdentity(request, auth)),
        requestPolicy,
        auth,
      );
    }
    case "segment": {
      const projectId = requiredRouteValue(requestPolicy.projectId, "project id");
      const sessionId = requiredRouteValue(requestPolicy.sessionId, "session id");
      const segmentName = requiredRouteValue(requestPolicy.segmentName, "segment name");
      wideEvent.set({ project_id: projectId, session_id: sessionId, cache_hit: false });
      return applyResponsePolicy(
        await getSegment(env, projectId, sessionId, segmentName),
        requestPolicy,
        auth,
      );
    }
    case "not_found":
      return finalDashboardRouteError(auth);
    default:
      throw new Error(
        `Dashboard request policy returned unexpected action ${requestPolicy.action}.`,
      );
  }
}

async function handlePublicPageRequest(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  wideEvent: ReturnType<typeof startWideEvent>,
  requestId: string,
  requestPolicy: DashboardRequestPolicy,
): Promise<Response> {
  if (
    requestPolicy.handlerRateLimit === "public_page" &&
    !(await publicPageRateLimitAllows(env, request))
  ) {
    wideEvent.set({ rate_limit: "public_page" });
    return jsonError("rate_limited", 429, { "cache-control": "no-store" });
  }

  const publicId = requiredRouteValue(requestPolicy.publicId, "public id");
  if (!requestPolicy.publicIdValid) return jsonError("invalid_path_id", 400);
  wideEvent.set({ public_id: publicId, auth_mode: "public" });

  if (requestPolicy.action === "public_page_data") {
    return getPublicPageDataResponse(url, env, ctx, publicId, requestId, wideEvent);
  }

  const publicReplayId = requiredRouteValue(requestPolicy.publicReplayId, "public replay id");
  if (!requestPolicy.publicReplayIdValid) return jsonError("invalid_path_id", 400);
  wideEvent.set({ public_replay_id: publicReplayId });

  if (requestPolicy.action === "public_manifest") {
    return getPublicManifest(env, publicId, publicReplayId);
  }

  if (requestPolicy.action === "public_segment") {
    const segmentName = requiredRouteValue(requestPolicy.segmentName, "segment name");
    if (!requestPolicy.segmentNameValid) return jsonError("invalid_segment_name", 400);
    return getPublicSegment(env, publicId, publicReplayId, segmentName);
  }

  throw new Error(
    `Dashboard request policy returned unexpected public action ${requestPolicy.action}.`,
  );
}

function dashboardAccessError(
  requestPolicy: DashboardRequestPolicy,
  auth: ApiAuthContext,
): Response | null {
  if (requestPolicy.access === "none" || requestPolicy.access === "authenticated") return null;

  if (requestPolicy.access === "session") {
    return isSessionAuth(auth) ? null : jsonError("unauthorized", 401);
  }

  if (requestPolicy.access === "global_admin") {
    const authError = globalAdminAuthError(auth);
    if (authError !== null) return authError;
    return isSessionAuth(auth) ? null : jsonError("forbidden", 403);
  }

  const projectId = requestPolicy.projectId;
  const projectRoute = requestPolicy.projectRoute;
  const needsSessionId =
    requestPolicy.action === "manifest" ||
    requestPolicy.action === "session_state" ||
    requestPolicy.action === "live_ticket" ||
    requestPolicy.action === "segment";
  const needsKeyId = requestPolicy.action === "project_key_revoke";
  if (
    projectId === null ||
    projectRoute === null ||
    !requestPolicy.projectIdValid ||
    !requestPolicy.sessionIdValid ||
    !requestPolicy.keyIdValid ||
    (needsSessionId && requestPolicy.sessionId === null) ||
    (needsKeyId && requestPolicy.keyId === null)
  ) {
    return jsonError("invalid_path_id", 400);
  }

  const authError = projectAuthError(auth, projectId, projectRoute);
  if (authError !== null) return authError;

  if (
    requestPolicy.action === "segment" &&
    (requestPolicy.segmentName === null || !requestPolicy.segmentNameValid)
  ) {
    return jsonError("invalid_segment_name", 400);
  }

  if (requestPolicy.requiresSessionAuth && !isSessionAuth(auth)) {
    return jsonError("unauthorized", 401);
  }

  return null;
}

function policyMutationOriginError(
  requestPolicy: DashboardRequestPolicy,
  request: Request,
  env: Env,
  auth: ApiAuthContext,
): Response | null {
  return requestPolicy.requiresTrustedMutationOrigin
    ? mutationOriginError(request, env, auth)
    : null;
}

function applyResponsePolicy(
  response: Response,
  requestPolicy: DashboardRequestPolicy,
  auth?: ApiAuthContext,
): Response {
  if (requestPolicy.responsePolicy === "security_headers") {
    return withSecurityHeaders(response);
  }
  if (requestPolicy.responsePolicy === "authenticated_project") {
    if (auth === undefined) {
      throw new Error("Dashboard request policy needs project authentication for its response.");
    }
    return authenticatedProjectResponse(response, auth);
  }
  return response;
}

function finalDashboardRouteError(auth: ApiAuthContext): Response {
  return auth.mode === "demo" ? jsonError("unauthorized", 401) : jsonError("not_found", 404);
}

function requiredRouteValue(value: string | null, name: string): string {
  if (value === null || value.length === 0) {
    throw new Error(`Dashboard request policy is missing ${name}.`);
  }
  return value;
}

function liveViewerIdentity(request: Request, auth: ApiAuthContext): string {
  if (auth.mode === "session") return `user:${auth.hostedSession.user.id}`;
  return `demo:${request.headers.get("cf-connecting-ip")?.trim() || "unknown"}`;
}

async function analyticsReadRateLimitError(
  env: Env,
  auth: ApiAuthContext,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
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
