import { isValidPathId, isValidSegmentName } from "../query/session-query.ts";

/**
 * Route names used for wide-event logging. A method-mismatched request keeps
 * its route name while dispatching as an authenticated not-found.
 */
export type DashboardRouteName =
  | "better_auth"
  | "auth_config"
  | "account"
  | "account_bootstrap"
  | "admin_stats"
  | "admin_users"
  | "demo_discovery"
  | "health"
  | "public_page_data"
  | "public_manifest"
  | "public_segment"
  | "sessions_list"
  | "session_heads"
  | "project_stats"
  | "project_live"
  | "project_config"
  | "install_status"
  | "public_page_settings"
  | "project_keys"
  | "project_key"
  | "manifest"
  | "session_state"
  | "live_ticket"
  | "segment"
  | "live"
  | "not_found";

export type DashboardProjectRouteName =
  | "sessions_list"
  | "session_heads"
  | "session_state"
  | "project_stats"
  | "project_live"
  | "project_config_read"
  | "project_config_write"
  | "public_page_read"
  | "public_page_write"
  | "install_status"
  | "project_keys"
  | "manifest"
  | "live_ticket"
  | "segment";

export interface DashboardProjectAccess {
  demoReadable: boolean;
  minimumRole: "member" | "manager";
}

const PROJECT_ACCESS: Readonly<Record<DashboardProjectRouteName, DashboardProjectAccess>> = {
  sessions_list: { demoReadable: true, minimumRole: "member" },
  session_heads: { demoReadable: true, minimumRole: "member" },
  session_state: { demoReadable: true, minimumRole: "member" },
  project_stats: { demoReadable: true, minimumRole: "member" },
  project_live: { demoReadable: true, minimumRole: "member" },
  project_config_read: { demoReadable: false, minimumRole: "member" },
  project_config_write: { demoReadable: false, minimumRole: "manager" },
  public_page_read: { demoReadable: false, minimumRole: "manager" },
  public_page_write: { demoReadable: false, minimumRole: "manager" },
  install_status: { demoReadable: false, minimumRole: "member" },
  project_keys: { demoReadable: false, minimumRole: "manager" },
  manifest: { demoReadable: true, minimumRole: "member" },
  live_ticket: { demoReadable: true, minimumRole: "member" },
  segment: { demoReadable: true, minimumRole: "member" },
};

export function projectRouteAccess(route: DashboardProjectRouteName): DashboardProjectAccess {
  return PROJECT_ACCESS[route];
}

export interface ProjectIds {
  projectId: string;
}
export interface SessionIds extends ProjectIds {
  sessionId: string;
}
export interface SegmentIds extends SessionIds {
  segmentName: string;
}
export interface KeyIds extends ProjectIds {
  keyId: string;
}

/**
 * Path ids for a project route, validated at match time. An invalid segment
 * name still carries its valid path ids because project access is checked
 * before the segment name is rejected.
 */
export type ProjectParams<Ids extends ProjectIds> =
  | { ok: true; ids: Ids }
  | { ok: false; error: "invalid_path_id" }
  | { ok: false; error: "invalid_segment_name"; ids: SessionIds };

export interface PublicPageIds {
  publicId: string;
}
export interface PublicReplayIds extends PublicPageIds {
  publicReplayId: string;
}
export interface PublicSegmentIds extends PublicReplayIds {
  segmentName: string;
}

/**
 * Public-page ids fail on the first invalid path segment; `logged` carries the
 * ids that validated before the failure so the wide event keeps them.
 */
export type PublicPageParams<Ids extends PublicPageIds> =
  | { ok: true; ids: Ids }
  | {
      ok: false;
      error: "invalid_path_id" | "invalid_segment_name";
      logged: Partial<PublicReplayIds>;
    };

export type PublicPagePlan =
  | {
      kind: "public_page";
      routeName: "public_page_data";
      action: "page_data";
      params: PublicPageParams<PublicPageIds>;
    }
  | {
      kind: "public_page";
      routeName: "public_manifest";
      action: "manifest";
      params: PublicPageParams<PublicReplayIds>;
    }
  | {
      kind: "public_page";
      routeName: "public_segment";
      action: "segment";
      params: PublicPageParams<PublicSegmentIds>;
    };

interface ProjectRouteFlags {
  access: "project";
  /** Key into the demo/role access matrix. */
  route: DashboardProjectRouteName;
  sessionAuthRequired: boolean;
  mutationOrigin: boolean;
  analyticsReadLimit: boolean;
  /** False only for the config method-not-allowed exception. */
  authenticatedResponse: boolean;
}

export type ProjectRoutePlan = ProjectRouteFlags &
  (
    | {
        action:
          | "sessions_list"
          | "session_heads"
          | "project_stats"
          | "project_live"
          | "project_config_read"
          | "project_config_write"
          | "install_status"
          | "public_page_read"
          | "public_page_write"
          | "project_keys_read"
          | "project_keys_create";
        params: ProjectParams<ProjectIds>;
      }
    | { action: "project_config_method_not_allowed"; params: ProjectParams<ProjectIds> }
    | { action: "manifest" | "session_state" | "live_ticket"; params: ProjectParams<SessionIds> }
    | { action: "project_key_revoke"; params: ProjectParams<KeyIds> }
    | { action: "segment"; params: ProjectParams<SegmentIds> }
  );

/**
 * The routes the executor registry dispatches. Method-not-allowed denial is
 * pipeline semantics and never reaches an executor.
 */
export type ExecutableProjectRoutePlan = Exclude<
  ProjectRoutePlan,
  { action: "project_config_method_not_allowed" }
>;

export type AuthedRoute =
  | { access: "authenticated"; action: "not_found" }
  | { access: "session"; action: "account"; mutationOrigin: false }
  | { access: "session"; action: "account_bootstrap"; mutationOrigin: true }
  | { access: "global_admin"; action: "admin_stats" | "admin_users" }
  | ProjectRoutePlan;

export interface AuthedPlan {
  kind: "authed";
  routeName: DashboardRouteName;
  /**
   * Raw first path segment under /api/v1/projects/, extracted even for
   * unknown routes so the demo-project auth shortcut sees every request.
   */
  projectIdForAuth: string | null;
  route: AuthedRoute;
}

export type DashboardRequestPlan =
  | { kind: "better_auth"; routeName: "better_auth" }
  | {
      kind: "public";
      routeName: DashboardRouteName;
      action: "health" | "auth_config" | "demo_discovery";
    }
  | PublicPagePlan
  | { kind: "ticket_live"; routeName: "live"; params: ProjectParams<SessionIds> }
  | AuthedPlan;

const PUBLIC_PAGE_PATTERN = /^\/api\/v1\/public-pages\/([^/]+)$/;
const PUBLIC_MANIFEST_PATTERN = /^\/api\/v1\/public-pages\/([^/]+)\/replays\/([^/]+)\/manifest$/;
const PUBLIC_SEGMENT_PATTERN =
  /^\/api\/v1\/public-pages\/([^/]+)\/replays\/([^/]+)\/segments\/([^/]+)$/;
const LIVE_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live$/;
const SESSIONS_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/sessions$/;
const SESSION_HEADS_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/session-heads$/;
const STATS_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/stats$/;
const PROJECT_LIVE_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/live$/;
const CONFIG_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/config$/;
const INSTALL_STATUS_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/install-status$/;
const PUBLIC_PAGE_SETTINGS_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/public-page$/;
const PROJECT_KEYS_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/keys$/;
const PROJECT_KEY_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/keys\/([^/]+)$/;
const MANIFEST_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/manifest$/;
const SESSION_STATE_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/state$/;
const LIVE_TICKET_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live-ticket$/;
const SEGMENT_PATTERN = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/segments\/(.+)$/;
const PROJECT_ID_PREFIX_PATTERN = /^\/api\/v1\/projects\/([^/]+)/;

const PROJECT_DEFAULTS = {
  access: "project",
  sessionAuthRequired: false,
  mutationOrigin: false,
  analyticsReadLimit: false,
  authenticatedResponse: true,
} as const;

export function matchDashboardRequest(method: string, pathname: string): DashboardRequestPlan {
  if (pathname === "/api/v1/health") {
    return method === "GET"
      ? { kind: "public", routeName: "health", action: "health" }
      : unsupported(pathname, "health");
  }

  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
    return { kind: "better_auth", routeName: "better_auth" };
  }

  if (pathname === "/api/v1/auth/config") {
    return method === "GET"
      ? { kind: "public", routeName: "auth_config", action: "auth_config" }
      : unsupported(pathname, "auth_config");
  }

  if (pathname === "/api/v1/demo") {
    return method === "GET"
      ? { kind: "public", routeName: "demo_discovery", action: "demo_discovery" }
      : unsupported(pathname, "demo_discovery");
  }

  let match = PUBLIC_PAGE_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? {
          kind: "public_page",
          routeName: "public_page_data",
          action: "page_data",
          params: publicPageParams(match[1] ?? null),
        }
      : unsupported(pathname, "public_page_data");
  }

  match = PUBLIC_MANIFEST_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? {
          kind: "public_page",
          routeName: "public_manifest",
          action: "manifest",
          params: publicReplayParams(match[1] ?? null, match[2] ?? null),
        }
      : unsupported(pathname, "public_manifest");
  }

  match = PUBLIC_SEGMENT_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? {
          kind: "public_page",
          routeName: "public_segment",
          action: "segment",
          params: publicSegmentParams(match[1] ?? null, match[2] ?? null, match[3] ?? null),
        }
      : unsupported(pathname, "public_segment");
  }

  match = LIVE_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? {
          kind: "ticket_live",
          routeName: "live",
          params: sessionParams(match[1] ?? null, match[2] ?? null),
        }
      : unsupported(pathname, "live");
  }

  if (pathname === "/api/v1/account") {
    return method === "GET"
      ? authed(pathname, "account", { access: "session", action: "account", mutationOrigin: false })
      : unsupported(pathname, "account");
  }

  if (pathname === "/api/v1/account/bootstrap") {
    return method === "POST"
      ? authed(pathname, "account_bootstrap", {
          access: "session",
          action: "account_bootstrap",
          mutationOrigin: true,
        })
      : unsupported(pathname, "account_bootstrap");
  }

  if (pathname === "/api/v1/admin/stats") {
    return method === "GET"
      ? authed(pathname, "admin_stats", { access: "global_admin", action: "admin_stats" })
      : unsupported(pathname, "admin_stats");
  }

  if (pathname === "/api/v1/admin/users") {
    return method === "GET"
      ? authed(pathname, "admin_users", { access: "global_admin", action: "admin_users" })
      : unsupported(pathname, "admin_users");
  }

  match = SESSIONS_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? authed(pathname, "sessions_list", {
          ...PROJECT_DEFAULTS,
          route: "sessions_list",
          analyticsReadLimit: true,
          action: "sessions_list",
          params: projectParams(match[1] ?? null),
        })
      : unsupported(pathname, "sessions_list");
  }

  match = SESSION_HEADS_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? authed(pathname, "session_heads", {
          ...PROJECT_DEFAULTS,
          route: "session_heads",
          action: "session_heads",
          params: projectParams(match[1] ?? null),
        })
      : unsupported(pathname, "session_heads");
  }

  match = STATS_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? authed(pathname, "project_stats", {
          ...PROJECT_DEFAULTS,
          route: "project_stats",
          analyticsReadLimit: true,
          action: "project_stats",
          params: projectParams(match[1] ?? null),
        })
      : unsupported(pathname, "project_stats");
  }

  match = PROJECT_LIVE_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? authed(pathname, "project_live", {
          ...PROJECT_DEFAULTS,
          route: "project_live",
          action: "project_live",
          params: projectParams(match[1] ?? null),
        })
      : unsupported(pathname, "project_live");
  }

  match = CONFIG_PATTERN.exec(pathname);
  if (match !== null) {
    const params = projectParams(match[1] ?? null);
    if (method === "GET") {
      return authed(pathname, "project_config", {
        ...PROJECT_DEFAULTS,
        route: "project_config_read",
        action: "project_config_read",
        params,
      });
    }
    if (method === "PUT") {
      return authed(pathname, "project_config", {
        ...PROJECT_DEFAULTS,
        route: "project_config_write",
        mutationOrigin: true,
        action: "project_config_write",
        params,
      });
    }
    // Config keeps project semantics for unsupported methods: access is
    // checked as a read before the not-found style denial.
    return authed(pathname, "project_config", {
      ...PROJECT_DEFAULTS,
      route: "project_config_read",
      authenticatedResponse: false,
      action: "project_config_method_not_allowed",
      params,
    });
  }

  match = INSTALL_STATUS_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? authed(pathname, "install_status", {
          ...PROJECT_DEFAULTS,
          route: "install_status",
          action: "install_status",
          params: projectParams(match[1] ?? null),
        })
      : unsupported(pathname, "install_status");
  }

  match = PUBLIC_PAGE_SETTINGS_PATTERN.exec(pathname);
  if (match !== null) {
    if (method === "GET") {
      return authed(pathname, "public_page_settings", {
        ...PROJECT_DEFAULTS,
        route: "public_page_read",
        action: "public_page_read",
        params: projectParams(match[1] ?? null),
      });
    }
    if (method === "PUT") {
      return authed(pathname, "public_page_settings", {
        ...PROJECT_DEFAULTS,
        route: "public_page_write",
        mutationOrigin: true,
        action: "public_page_write",
        params: projectParams(match[1] ?? null),
      });
    }
    return unsupported(pathname, "public_page_settings");
  }

  match = PROJECT_KEYS_PATTERN.exec(pathname);
  if (match !== null) {
    if (method === "GET") {
      return authed(pathname, "project_keys", {
        ...PROJECT_DEFAULTS,
        route: "project_keys",
        sessionAuthRequired: true,
        action: "project_keys_read",
        params: projectParams(match[1] ?? null),
      });
    }
    if (method === "POST") {
      return authed(pathname, "project_keys", {
        ...PROJECT_DEFAULTS,
        route: "project_keys",
        sessionAuthRequired: true,
        mutationOrigin: true,
        action: "project_keys_create",
        params: projectParams(match[1] ?? null),
      });
    }
    return unsupported(pathname, "project_keys");
  }

  match = PROJECT_KEY_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "DELETE"
      ? authed(pathname, "project_key", {
          ...PROJECT_DEFAULTS,
          route: "project_keys",
          sessionAuthRequired: true,
          mutationOrigin: true,
          action: "project_key_revoke",
          params: keyParams(match[1] ?? null, match[2] ?? null),
        })
      : unsupported(pathname, "project_key");
  }

  match = MANIFEST_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? authed(pathname, "manifest", {
          ...PROJECT_DEFAULTS,
          route: "manifest",
          action: "manifest",
          params: sessionParams(match[1] ?? null, match[2] ?? null),
        })
      : unsupported(pathname, "manifest");
  }

  match = SESSION_STATE_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? authed(pathname, "session_state", {
          ...PROJECT_DEFAULTS,
          route: "session_state",
          action: "session_state",
          params: sessionParams(match[1] ?? null, match[2] ?? null),
        })
      : unsupported(pathname, "session_state");
  }

  match = LIVE_TICKET_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "POST"
      ? authed(pathname, "live_ticket", {
          ...PROJECT_DEFAULTS,
          route: "live_ticket",
          mutationOrigin: true,
          action: "live_ticket",
          params: sessionParams(match[1] ?? null, match[2] ?? null),
        })
      : unsupported(pathname, "live_ticket");
  }

  match = SEGMENT_PATTERN.exec(pathname);
  if (match !== null) {
    return method === "GET"
      ? authed(pathname, "segment", {
          ...PROJECT_DEFAULTS,
          route: "segment",
          action: "segment",
          params: segmentParams(match[1] ?? null, match[2] ?? null, match[3] ?? null),
        })
      : unsupported(pathname, "segment");
  }

  return unsupported(pathname, "not_found");
}

function authed(pathname: string, routeName: DashboardRouteName, route: AuthedRoute): AuthedPlan {
  return {
    kind: "authed",
    routeName,
    projectIdForAuth: PROJECT_ID_PREFIX_PATTERN.exec(pathname)?.[1] ?? null,
    route,
  };
}

function unsupported(pathname: string, routeName: DashboardRouteName): AuthedPlan {
  return authed(pathname, routeName, { access: "authenticated", action: "not_found" });
}

const INVALID_PATH = { ok: false, error: "invalid_path_id" } as const;

function projectParams(projectId: string | null): ProjectParams<ProjectIds> {
  return projectId !== null && isValidPathId(projectId)
    ? { ok: true, ids: { projectId } }
    : INVALID_PATH;
}

function sessionParams(
  projectId: string | null,
  sessionId: string | null,
): ProjectParams<SessionIds> {
  if (
    projectId === null ||
    sessionId === null ||
    !isValidPathId(projectId) ||
    !isValidPathId(sessionId)
  ) {
    return INVALID_PATH;
  }
  return { ok: true, ids: { projectId, sessionId } };
}

function keyParams(projectId: string | null, keyId: string | null): ProjectParams<KeyIds> {
  if (projectId === null || keyId === null || !isValidPathId(projectId) || !isValidPathId(keyId)) {
    return INVALID_PATH;
  }
  return { ok: true, ids: { projectId, keyId } };
}

function segmentParams(
  projectId: string | null,
  sessionId: string | null,
  segmentName: string | null,
): ProjectParams<SegmentIds> {
  const base = sessionParams(projectId, sessionId);
  if (!base.ok) return INVALID_PATH;
  if (segmentName === null || !isValidSegmentName(segmentName)) {
    return { ok: false, error: "invalid_segment_name", ids: base.ids };
  }
  return { ok: true, ids: { ...base.ids, segmentName } };
}

function publicPageParams(publicId: string | null): PublicPageParams<PublicPageIds> {
  if (publicId === null || !isValidPathId(publicId)) {
    return { ok: false, error: "invalid_path_id", logged: {} };
  }
  return { ok: true, ids: { publicId } };
}

function publicReplayParams(
  publicId: string | null,
  publicReplayId: string | null,
): PublicPageParams<PublicReplayIds> {
  if (publicId === null || !isValidPathId(publicId)) {
    return { ok: false, error: "invalid_path_id", logged: {} };
  }
  if (publicReplayId === null || !isValidPathId(publicReplayId)) {
    return { ok: false, error: "invalid_path_id", logged: { publicId } };
  }
  return { ok: true, ids: { publicId, publicReplayId } };
}

function publicSegmentParams(
  publicId: string | null,
  publicReplayId: string | null,
  segmentName: string | null,
): PublicPageParams<PublicSegmentIds> {
  const base = publicReplayParams(publicId, publicReplayId);
  if (!base.ok) return base;
  if (segmentName === null || !isValidSegmentName(segmentName)) {
    return { ok: false, error: "invalid_segment_name", logged: base.ids };
  }
  return { ok: true, ids: { ...base.ids, segmentName } };
}
