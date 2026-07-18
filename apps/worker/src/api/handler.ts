import { HDR_REQUEST_ID, startWideEvent, uuidv7 } from "@orange-replay/shared";
import { getAuthMode, isTrustedMutationOrigin } from "../auth/config.ts";
import { checkAnalyticsReadRateLimit } from "../analytics/read-rate-limit.ts";
import { setWorkerLoggerVersion, type Env } from "../env.ts";
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
  type ProjectRoutePlan,
  type PublicPagePlan,
  type SessionIds,
} from "./dashboard-request-policy.ts";
import {
  DASHBOARD_EXECUTORS,
  finalDashboardRouteError,
  type DashboardExecutors,
  type DashboardRouteContext,
  type WideEvent,
} from "./dashboard-routes.ts";
import { outcomeForStatus } from "../query/session-query.ts";
import { jsonError, jsonResponse, withSecurityHeaders } from "../http.ts";
import { publicPageRateLimitAllows } from "../public-page/data.ts";

export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  executors: DashboardExecutors = DASHBOARD_EXECUTORS,
): Promise<Response> {
  setWorkerLoggerVersion(env);
  const url = new URL(request.url);
  const requestId = request.headers.get(HDR_REQUEST_ID) ?? uuidv7();
  const plan = matchDashboardRequest(request.method, url.pathname);
  const wideEvent = startWideEvent("worker", "api.request", requestId);
  const rctx: DashboardRouteContext = { request, url, env, ctx, wideEvent, requestId };
  let statusCode = 500;

  wideEvent.set({ route: plan.routeName });

  try {
    const response = await routeRequest(rctx, plan, executors);
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
  rctx: DashboardRouteContext,
  plan: ReturnType<typeof matchDashboardRequest>,
  executors: DashboardExecutors,
): Promise<Response> {
  switch (plan.kind) {
    case "better_auth":
      return withSecurityHeaders(await executors.betterAuth(rctx));
    case "public": {
      if (plan.action === "health") return jsonResponse({ ok: true });
      if (plan.action === "auth_config") {
        return jsonResponse(
          { mode: getAuthMode(rctx.env) },
          { headers: { "cache-control": "no-store" } },
        );
      }
      return executors.demoDiscovery(rctx);
    }
    case "public_page":
      return handlePublicPageRequest(rctx, plan, executors);
    case "ticket_live": {
      const params = plan.params;
      if (!params.ok) return jsonError("invalid_path_id", 400);
      const { projectId, sessionId } = params.ids;
      rctx.wideEvent.set({ project_id: projectId, session_id: sessionId, auth: "ticket" });
      return executors.liveProxy(rctx, params.ids);
    }
    case "authed":
      return handleAuthedRequest(rctx, plan, executors);
  }
}

async function handlePublicPageRequest(
  rctx: DashboardRouteContext,
  plan: PublicPagePlan,
  executors: DashboardExecutors,
): Promise<Response> {
  const { request, env, wideEvent } = rctx;
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
  if ("publicReplayId" in params.ids) {
    wideEvent.set({ public_replay_id: params.ids.publicReplayId });
  }
  return executors.publicPage(rctx, plan);
}

async function handleAuthedRequest(
  rctx: DashboardRouteContext,
  plan: AuthedPlan,
  executors: DashboardExecutors,
): Promise<Response> {
  const { request, env, ctx, wideEvent } = rctx;
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
    return route.action === "account"
      ? executors.account(rctx, auth)
      : executors.accountBootstrap(rctx, auth);
  }

  if (route.access === "global_admin") {
    const adminError = globalAdminAuthError(auth);
    if (adminError !== null) return adminError;
    if (!isSessionAuth(auth)) return jsonError("forbidden", 403);
    wideEvent.set({ user_id: auth.hostedSession.user.id });
    return route.action === "admin_stats" ? executors.adminStats(rctx) : executors.adminUsers(rctx);
  }

  return handleProjectRoute(rctx, auth, route, executors);
}

async function handleProjectRoute(
  rctx: DashboardRouteContext,
  auth: ApiAuthContext,
  route: ProjectRoutePlan,
  executors: DashboardExecutors,
): Promise<Response> {
  const { request, env, wideEvent } = rctx;
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

  // Method-not-allowed denial is pipeline semantics, not route work.
  if (route.action === "project_config_method_not_allowed") {
    return finalDashboardRouteError(auth);
  }

  const response = await executors.project(rctx, auth, route);
  return route.authenticatedResponse ? authenticatedProjectResponse(response, auth) : response;
}

function projectLogFields(ids: ProjectIds & Partial<SessionIds & KeyIds>): Record<string, string> {
  const fields: Record<string, string> = { project_id: ids.projectId };
  if (ids.sessionId !== undefined) fields.session_id = ids.sessionId;
  if (ids.keyId !== undefined) fields.key_id = ids.keyId;
  return fields;
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
