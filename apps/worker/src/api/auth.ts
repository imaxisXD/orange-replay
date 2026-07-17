import { getAuthMode } from "../auth/config.ts";
import { getHostedSession, isGlobalAdmin, type HostedSession } from "../auth/server.ts";
import { isDevTestMode, type Env } from "../env.ts";
import { projectRouteAccess, type DashboardProjectRouteName } from "./dashboard-request-policy.ts";
import { isValidPathId } from "./helpers.ts";
import { jsonError } from "./http.ts";

const PLACEHOLDER_PREFIX = "REPLACE_WITH_";

export type ApiAuthMode = "demo" | "session";
export type ProjectRole = "owner" | "admin" | "member";

type DemoAuthContext = {
  ok: true;
  projects: ReadonlySet<string>;
  mode: "demo";
};

export type SessionAuthContext = {
  ok: true;
  mode: "session";
  projects: ReadonlySet<string>;
  projectRoles: ReadonlyMap<string, ProjectRole>;
  hostedSession: HostedSession;
  globalAdmin: boolean;
};

export type ApiAuthContext = DemoAuthContext | SessionAuthContext;

export type ApiRouteName = DashboardProjectRouteName;

interface ProjectMembershipRow {
  [key: string]: unknown;
  project_id: string;
  role: string;
}

export async function demoRateLimitAllows(env: Env, request: Request): Promise<boolean> {
  if (env.DEMO_API_RATE_LIMITER === undefined) {
    return isDevTestMode(env);
  }

  const source = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  try {
    const result = await env.DEMO_API_RATE_LIMITER.limit({ key: `demo:ip:${source}` });
    return result.success;
  } catch {
    return false;
  }
}

export async function checkAuth(
  request: Request,
  env: Env,
  routeProjectId: string | null,
  executionContext?: ExecutionContext,
): Promise<ApiAuthContext | { ok: false; status: 401 | 503; error: string }> {
  const header = request.headers.get("authorization");
  const authMode = getAuthMode(env);

  // Dashboard bearer tokens are not supported. An explicit Authorization
  // header must never fall through to anonymous demo or cookie auth.
  if (header !== null) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const demo = readDemoConfig(env);
  if (demo !== null && routeProjectId === demo.projectId) {
    return { ok: true, projects: new Set([demo.projectId]), mode: "demo" };
  }

  if (authMode === "unavailable") {
    return { ok: false, status: 503, error: "auth_not_configured" };
  }

  const hostedSession = await getHostedSession(request, env, executionContext);
  if (hostedSession === null || hostedSession.user.banned) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const projectRoles = await readProjectRoles(env.IDX_00, hostedSession.user.id);
  return {
    ok: true,
    mode: "session",
    projects: new Set(projectRoles.keys()),
    projectRoles,
    hostedSession,
    globalAdmin: isGlobalAdmin(hostedSession, env),
  };
}

export function projectAuthError(
  auth: ApiAuthContext,
  projectId: string,
  route: ApiRouteName,
): Response | null {
  const access = projectRouteAccess(route);
  if (auth.mode === "demo" && !access.demoReadable) {
    return jsonError("unauthorized", 401);
  }

  if (!auth.projects.has(projectId)) {
    return jsonError("forbidden", 403);
  }

  if (auth.mode === "session" && access.minimumRole === "manager") {
    const role = auth.projectRoles.get(projectId);
    if (role !== "owner" && role !== "admin") {
      return jsonError("forbidden", 403);
    }
  }

  return null;
}

export function globalAdminAuthError(auth: ApiAuthContext): Response | null {
  return auth.mode === "session" && auth.globalAdmin ? null : jsonError("forbidden", 403);
}

export function isSessionAuth(auth: ApiAuthContext): auth is SessionAuthContext {
  return auth.mode === "session";
}

export function readDemoConfig(
  env: Pick<Env, "DEMO_PROJECT_ID" | "DEMO_WRITE_KEY">,
): { projectId: string; writeKey: string } | null {
  const projectId = readDemoString(env.DEMO_PROJECT_ID);
  const writeKey = readDemoString(env.DEMO_WRITE_KEY);
  if (projectId === null || writeKey === null || !isValidPathId(projectId)) {
    return null;
  }

  return { projectId, writeKey };
}

async function readProjectRoles(
  database: D1Database,
  userId: string,
): Promise<ReadonlyMap<string, ProjectRole>> {
  const rows = await database
    .prepare(
      `SELECT p.id AS project_id, m.role AS role
        FROM members m
        JOIN projects p ON p.org_id = m.org_id
        WHERE m.user_id = ?`,
    )
    .bind(userId)
    .all<ProjectMembershipRow>();

  const roles = new Map<string, ProjectRole>();
  for (const row of rows.results ?? []) {
    if (isProjectRole(row.role)) {
      roles.set(row.project_id, row.role);
    }
  }
  return roles;
}

function isProjectRole(value: string): value is ProjectRole {
  return value === "owner" || value === "admin" || value === "member";
}

function readDemoString(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (value.length === 0 || value.trim() !== value || value.startsWith(PLACEHOLDER_PREFIX)) {
    return null;
  }

  return value;
}
