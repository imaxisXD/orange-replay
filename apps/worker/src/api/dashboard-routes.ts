import type { startWideEvent } from "@orange-replay/shared";
import { handleBetterAuthRequest } from "../auth/server.ts";
import type { Env } from "../env.ts";
import { bootstrapAccount, getAccount } from "./account-routes.ts";
import { getAdminStats, getAdminUsers } from "./admin-routes.ts";
import { isSessionAuth, type ApiAuthContext, type SessionAuthContext } from "./auth.ts";
import type {
  ProjectIds,
  ProjectParams,
  ProjectRoutePlan,
  PublicPageIds,
  PublicPageParams,
  PublicPagePlan,
  SessionIds,
} from "./dashboard-request-policy.ts";
import { jsonError } from "./http.ts";
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
} from "../public-page/data.ts";

export type WideEvent = ReturnType<typeof startWideEvent>;

export interface DashboardRouteContext {
  request: Request;
  url: URL;
  env: Env;
  ctx: ExecutionContext;
  wideEvent: WideEvent;
  requestId: string;
}

/**
 * The executors behind the dashboard request pipeline. The handler owns
 * ordering (auth, limits, access, origin, response policy); executors own
 * only the work of a granted route. Injectable so pipeline tests replace
 * route implementations without module mocks.
 */
export interface DashboardExecutors {
  betterAuth(rctx: DashboardRouteContext): Promise<Response>;
  demoDiscovery(rctx: DashboardRouteContext): Promise<Response>;
  publicPage(rctx: DashboardRouteContext, plan: PublicPagePlan): Promise<Response>;
  liveProxy(rctx: DashboardRouteContext, ids: SessionIds): Promise<Response>;
  account(rctx: DashboardRouteContext, auth: SessionAuthContext): Promise<Response>;
  accountBootstrap(rctx: DashboardRouteContext, auth: SessionAuthContext): Promise<Response>;
  adminStats(rctx: DashboardRouteContext): Promise<Response>;
  adminUsers(rctx: DashboardRouteContext): Promise<Response>;
  project(
    rctx: DashboardRouteContext,
    auth: ApiAuthContext,
    route: ProjectRoutePlan,
  ): Promise<Response>;
}

export const DASHBOARD_EXECUTORS: DashboardExecutors = {
  betterAuth: ({ request, env, ctx }) => handleBetterAuthRequest(request, env, ctx),
  demoDiscovery: ({ request, env, wideEvent }) => getDemoDiscovery(request, env, wideEvent),
  publicPage: executePublicPageRoute,
  liveProxy: ({ request, url, env, requestId }, ids) =>
    proxyLiveSession(request, url, env, ids.projectId, ids.sessionId, requestId),
  account: ({ env }, auth) => getAccount(env, auth),
  accountBootstrap: ({ env }, auth) => bootstrapAccount(env, auth),
  adminStats: ({ env }) => getAdminStats(env),
  adminUsers: ({ url, env }) => getAdminUsers(url, env),
  project: executeProjectRoute,
};

export function finalDashboardRouteError(auth: ApiAuthContext): Response {
  return auth.mode === "demo" ? jsonError("unauthorized", 401) : jsonError("not_found", 404);
}

async function executePublicPageRoute(
  rctx: DashboardRouteContext,
  plan: PublicPagePlan,
): Promise<Response> {
  const { url, env, ctx, wideEvent, requestId } = rctx;
  switch (plan.action) {
    case "page_data": {
      const { publicId } = grantedPublicIds(plan.params);
      return getPublicPageDataResponse(url, env, ctx, publicId, requestId, wideEvent);
    }
    case "manifest": {
      const { publicId, publicReplayId } = grantedPublicIds(plan.params);
      return getPublicManifest(env, publicId, publicReplayId);
    }
    case "segment": {
      const { publicId, publicReplayId, segmentName } = grantedPublicIds(plan.params);
      return getPublicSegment(env, publicId, publicReplayId, segmentName);
    }
  }
}

async function executeProjectRoute(
  rctx: DashboardRouteContext,
  auth: ApiAuthContext,
  route: ProjectRoutePlan,
): Promise<Response> {
  const { request, url, env, ctx, wideEvent, requestId } = rctx;
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

function grantedIds<Ids extends ProjectIds>(params: ProjectParams<Ids>): Ids {
  if (!params.ok) throw new Error("Project route executed without validated ids.");
  return params.ids;
}

function grantedPublicIds<Ids extends PublicPageIds>(params: PublicPageParams<Ids>): Ids {
  if (!params.ok) throw new Error("Public page route executed without validated ids.");
  return params.ids;
}

function liveViewerIdentity(request: Request, auth: ApiAuthContext): string {
  if (auth.mode === "session") return `user:${auth.hostedSession.user.id}`;
  return `demo:${request.headers.get("cf-connecting-ip")?.trim() || "unknown"}`;
}
