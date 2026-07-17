import { isValidPathId, isValidSegmentName } from "./helpers.ts";

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

export type DashboardRequestAction =
  | "health"
  | "better_auth"
  | "auth_config"
  | "demo_discovery"
  | "public_page_data"
  | "public_manifest"
  | "public_segment"
  | "live"
  | "account"
  | "account_bootstrap"
  | "admin_stats"
  | "admin_users"
  | "sessions_list"
  | "session_heads"
  | "project_stats"
  | "project_live"
  | "project_config_read"
  | "project_config_write"
  | "project_config_method_not_allowed"
  | "install_status"
  | "public_page_read"
  | "public_page_write"
  | "project_keys_read"
  | "project_keys_create"
  | "project_key_revoke"
  | "manifest"
  | "session_state"
  | "live_ticket"
  | "segment"
  | "not_found";

export type DashboardAuthentication = "public" | "better_auth" | "ticket" | "dashboard";
export type DashboardAccess = "none" | "authenticated" | "session" | "global_admin" | "project";
export type DashboardRateLimit = "none" | "public_page" | "analytics_read";
export type DashboardResponsePolicy = "none" | "security_headers" | "authenticated_project";

export interface DashboardProjectAccess {
  demoReadable: boolean;
  minimumRole: "member" | "manager";
}

export interface DashboardRequestPolicy {
  action: DashboardRequestAction;
  routeName: DashboardRouteName;
  methodAllowed: boolean;
  authentication: DashboardAuthentication;
  access: DashboardAccess;
  projectIdForAuth: string | null;
  projectRoute: DashboardProjectRouteName | null;
  projectId: string | null;
  projectIdValid: boolean;
  sessionId: string | null;
  sessionIdValid: boolean;
  keyId: string | null;
  keyIdValid: boolean;
  publicId: string | null;
  publicIdValid: boolean;
  publicReplayId: string | null;
  publicReplayIdValid: boolean;
  segmentName: string | null;
  segmentNameValid: boolean;
  requiresSessionAuth: boolean;
  requiresTrustedMutationOrigin: boolean;
  demoRateLimit: boolean;
  handlerRateLimit: DashboardRateLimit;
  responsePolicy: DashboardResponsePolicy;
}

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

export function matchDashboardRequest(method: string, pathname: string): DashboardRequestPolicy {
  if (pathname === "/api/v1/health") {
    return method === "GET"
      ? createPolicy(pathname, {
          action: "health",
          routeName: "health",
          methodAllowed: true,
          authentication: "public",
        })
      : unsupportedPolicy(pathname, "health");
  }

  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
    return createPolicy(pathname, {
      action: "better_auth",
      routeName: "better_auth",
      methodAllowed: true,
      authentication: "better_auth",
      responsePolicy: "security_headers",
    });
  }

  if (pathname === "/api/v1/auth/config") {
    return method === "GET"
      ? createPolicy(pathname, {
          action: "auth_config",
          routeName: "auth_config",
          methodAllowed: true,
          authentication: "public",
        })
      : unsupportedPolicy(pathname, "auth_config");
  }

  if (pathname === "/api/v1/demo") {
    return method === "GET"
      ? createPolicy(pathname, {
          action: "demo_discovery",
          routeName: "demo_discovery",
          methodAllowed: true,
          authentication: "public",
        })
      : unsupportedPolicy(pathname, "demo_discovery");
  }

  let match = PUBLIC_PAGE_PATTERN.exec(pathname);
  if (match !== null) {
    const publicId = match[1] ?? null;
    return method === "GET"
      ? createPolicy(pathname, {
          action: "public_page_data",
          routeName: "public_page_data",
          methodAllowed: true,
          authentication: "public",
          publicId,
          handlerRateLimit: "public_page",
        })
      : unsupportedPolicy(pathname, "public_page_data", { publicId });
  }

  match = PUBLIC_MANIFEST_PATTERN.exec(pathname);
  if (match !== null) {
    const publicId = match[1] ?? null;
    const publicReplayId = match[2] ?? null;
    return method === "GET"
      ? createPolicy(pathname, {
          action: "public_manifest",
          routeName: "public_manifest",
          methodAllowed: true,
          authentication: "public",
          publicId,
          publicReplayId,
          handlerRateLimit: "public_page",
        })
      : unsupportedPolicy(pathname, "public_manifest", { publicId, publicReplayId });
  }

  match = PUBLIC_SEGMENT_PATTERN.exec(pathname);
  if (match !== null) {
    const publicId = match[1] ?? null;
    const publicReplayId = match[2] ?? null;
    const segmentName = match[3] ?? null;
    return method === "GET"
      ? createPolicy(pathname, {
          action: "public_segment",
          routeName: "public_segment",
          methodAllowed: true,
          authentication: "public",
          publicId,
          publicReplayId,
          segmentName,
          handlerRateLimit: "public_page",
        })
      : unsupportedPolicy(pathname, "public_segment", {
          publicId,
          publicReplayId,
          segmentName,
        });
  }

  match = LIVE_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    const sessionId = match[2] ?? null;
    return method === "GET"
      ? createPolicy(pathname, {
          action: "live",
          routeName: "live",
          methodAllowed: true,
          authentication: "ticket",
          projectId,
          sessionId,
        })
      : unsupportedPolicy(pathname, "live", { projectId, sessionId });
  }

  if (pathname === "/api/v1/account") {
    return method === "GET"
      ? createPolicy(pathname, {
          action: "account",
          routeName: "account",
          methodAllowed: true,
          access: "session",
        })
      : unsupportedPolicy(pathname, "account");
  }

  if (pathname === "/api/v1/account/bootstrap") {
    return method === "POST"
      ? createPolicy(pathname, {
          action: "account_bootstrap",
          routeName: "account_bootstrap",
          methodAllowed: true,
          access: "session",
          requiresTrustedMutationOrigin: true,
        })
      : unsupportedPolicy(pathname, "account_bootstrap");
  }

  if (pathname === "/api/v1/admin/stats") {
    return method === "GET"
      ? createPolicy(pathname, {
          action: "admin_stats",
          routeName: "admin_stats",
          methodAllowed: true,
          access: "global_admin",
        })
      : unsupportedPolicy(pathname, "admin_stats");
  }

  if (pathname === "/api/v1/admin/users") {
    return method === "GET"
      ? createPolicy(pathname, {
          action: "admin_users",
          routeName: "admin_users",
          methodAllowed: true,
          access: "global_admin",
        })
      : unsupportedPolicy(pathname, "admin_users");
  }

  match = SESSIONS_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    return method === "GET"
      ? projectPolicy(pathname, {
          action: "sessions_list",
          routeName: "sessions_list",
          projectRoute: "sessions_list",
          projectId,
          handlerRateLimit: "analytics_read",
        })
      : unsupportedPolicy(pathname, "sessions_list", { projectId });
  }

  match = SESSION_HEADS_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    return method === "GET"
      ? projectPolicy(pathname, {
          action: "session_heads",
          routeName: "session_heads",
          projectRoute: "session_heads",
          projectId,
        })
      : unsupportedPolicy(pathname, "session_heads", { projectId });
  }

  match = STATS_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    return method === "GET"
      ? projectPolicy(pathname, {
          action: "project_stats",
          routeName: "project_stats",
          projectRoute: "project_stats",
          projectId,
          handlerRateLimit: "analytics_read",
        })
      : unsupportedPolicy(pathname, "project_stats", { projectId });
  }

  match = PROJECT_LIVE_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    return method === "GET"
      ? projectPolicy(pathname, {
          action: "project_live",
          routeName: "project_live",
          projectRoute: "project_live",
          projectId,
        })
      : unsupportedPolicy(pathname, "project_live", { projectId });
  }

  match = CONFIG_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    if (method === "GET") {
      return projectPolicy(pathname, {
        action: "project_config_read",
        routeName: "project_config",
        projectRoute: "project_config_read",
        projectId,
      });
    }
    if (method === "PUT") {
      return projectPolicy(pathname, {
        action: "project_config_write",
        routeName: "project_config",
        projectRoute: "project_config_write",
        projectId,
        requiresTrustedMutationOrigin: true,
      });
    }
    return projectPolicy(pathname, {
      action: "project_config_method_not_allowed",
      routeName: "project_config",
      methodAllowed: false,
      projectRoute: "project_config_read",
      projectId,
      responsePolicy: "none",
    });
  }

  match = INSTALL_STATUS_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    return method === "GET"
      ? projectPolicy(pathname, {
          action: "install_status",
          routeName: "install_status",
          projectRoute: "install_status",
          projectId,
        })
      : unsupportedPolicy(pathname, "install_status", { projectId });
  }

  match = PUBLIC_PAGE_SETTINGS_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    if (method === "GET") {
      return projectPolicy(pathname, {
        action: "public_page_read",
        routeName: "public_page_settings",
        projectRoute: "public_page_read",
        projectId,
      });
    }
    if (method === "PUT") {
      return projectPolicy(pathname, {
        action: "public_page_write",
        routeName: "public_page_settings",
        projectRoute: "public_page_write",
        projectId,
        requiresTrustedMutationOrigin: true,
      });
    }
    return unsupportedPolicy(pathname, "public_page_settings", { projectId });
  }

  match = PROJECT_KEYS_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    if (method === "GET") {
      return projectPolicy(pathname, {
        action: "project_keys_read",
        routeName: "project_keys",
        projectRoute: "project_keys",
        projectId,
        requiresSessionAuth: true,
      });
    }
    if (method === "POST") {
      return projectPolicy(pathname, {
        action: "project_keys_create",
        routeName: "project_keys",
        projectRoute: "project_keys",
        projectId,
        requiresSessionAuth: true,
        requiresTrustedMutationOrigin: true,
      });
    }
    return unsupportedPolicy(pathname, "project_keys", { projectId });
  }

  match = PROJECT_KEY_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    const keyId = match[2] ?? null;
    return method === "DELETE"
      ? projectPolicy(pathname, {
          action: "project_key_revoke",
          routeName: "project_key",
          projectRoute: "project_keys",
          projectId,
          keyId,
          requiresSessionAuth: true,
          requiresTrustedMutationOrigin: true,
        })
      : unsupportedPolicy(pathname, "project_key", { projectId, keyId });
  }

  match = MANIFEST_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    const sessionId = match[2] ?? null;
    return method === "GET"
      ? projectPolicy(pathname, {
          action: "manifest",
          routeName: "manifest",
          projectRoute: "manifest",
          projectId,
          sessionId,
        })
      : unsupportedPolicy(pathname, "manifest", { projectId, sessionId });
  }

  match = SESSION_STATE_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    const sessionId = match[2] ?? null;
    return method === "GET"
      ? projectPolicy(pathname, {
          action: "session_state",
          routeName: "session_state",
          projectRoute: "session_state",
          projectId,
          sessionId,
        })
      : unsupportedPolicy(pathname, "session_state", { projectId, sessionId });
  }

  match = LIVE_TICKET_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    const sessionId = match[2] ?? null;
    return method === "POST"
      ? projectPolicy(pathname, {
          action: "live_ticket",
          routeName: "live_ticket",
          projectRoute: "live_ticket",
          projectId,
          sessionId,
          requiresTrustedMutationOrigin: true,
        })
      : unsupportedPolicy(pathname, "live_ticket", { projectId, sessionId });
  }

  match = SEGMENT_PATTERN.exec(pathname);
  if (match !== null) {
    const projectId = match[1] ?? null;
    const sessionId = match[2] ?? null;
    const segmentName = match[3] ?? null;
    return method === "GET"
      ? projectPolicy(pathname, {
          action: "segment",
          routeName: "segment",
          projectRoute: "segment",
          projectId,
          sessionId,
          segmentName,
        })
      : unsupportedPolicy(pathname, "segment", { projectId, sessionId, segmentName });
  }

  return createPolicy(pathname, {
    action: "not_found",
    routeName: "not_found",
    methodAllowed: false,
  });
}

type PolicyInput = Pick<DashboardRequestPolicy, "action" | "routeName" | "methodAllowed"> &
  Partial<
    Omit<
      DashboardRequestPolicy,
      | "action"
      | "routeName"
      | "methodAllowed"
      | "projectIdForAuth"
      | "projectIdValid"
      | "sessionIdValid"
      | "keyIdValid"
      | "publicIdValid"
      | "publicReplayIdValid"
      | "segmentNameValid"
      | "demoRateLimit"
    >
  >;

type ProjectPolicyInput = Omit<PolicyInput, "methodAllowed" | "authentication" | "access"> & {
  methodAllowed?: boolean;
};

type UnsupportedIds = Pick<
  Partial<DashboardRequestPolicy>,
  "projectId" | "sessionId" | "keyId" | "publicId" | "publicReplayId" | "segmentName"
>;

function projectPolicy(pathname: string, input: ProjectPolicyInput): DashboardRequestPolicy {
  return createPolicy(pathname, {
    ...input,
    methodAllowed: input.methodAllowed ?? true,
    authentication: "dashboard",
    access: "project",
    responsePolicy: input.responsePolicy ?? "authenticated_project",
  });
}

function unsupportedPolicy(
  pathname: string,
  routeName: DashboardRouteName,
  ids: UnsupportedIds = {},
): DashboardRequestPolicy {
  return createPolicy(pathname, {
    action: "not_found",
    routeName,
    methodAllowed: false,
    ...ids,
  });
}

function createPolicy(pathname: string, input: PolicyInput): DashboardRequestPolicy {
  const authentication = input.authentication ?? "dashboard";
  const projectId = input.projectId ?? null;
  const sessionId = input.sessionId ?? null;
  const keyId = input.keyId ?? null;
  const publicId = input.publicId ?? null;
  const publicReplayId = input.publicReplayId ?? null;
  const segmentName = input.segmentName ?? null;

  return {
    action: input.action,
    routeName: input.routeName,
    methodAllowed: input.methodAllowed,
    authentication,
    access: input.access ?? (authentication === "dashboard" ? "authenticated" : "none"),
    projectIdForAuth: PROJECT_ID_PREFIX_PATTERN.exec(pathname)?.[1] ?? null,
    projectRoute: input.projectRoute ?? null,
    projectId,
    projectIdValid: projectId === null || isValidPathId(projectId),
    sessionId,
    sessionIdValid: sessionId === null || isValidPathId(sessionId),
    keyId,
    keyIdValid: keyId === null || isValidPathId(keyId),
    publicId,
    publicIdValid: publicId === null || isValidPathId(publicId),
    publicReplayId,
    publicReplayIdValid: publicReplayId === null || isValidPathId(publicReplayId),
    segmentName,
    segmentNameValid: segmentName === null || isValidSegmentName(segmentName),
    requiresSessionAuth: input.requiresSessionAuth ?? false,
    requiresTrustedMutationOrigin: input.requiresTrustedMutationOrigin ?? false,
    demoRateLimit: authentication === "dashboard",
    handlerRateLimit: input.handlerRateLimit ?? "none",
    responsePolicy: input.responsePolicy ?? "none",
  };
}
