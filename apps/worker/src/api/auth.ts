import { getAuthMode } from "../auth/config.ts";
import { getHostedSession, isGlobalAdmin, type HostedSession } from "../auth/server.ts";
import { isDevTestMode, type Env } from "../env.ts";
import { isValidPathId } from "./helpers.ts";
import { jsonError } from "./http.ts";

const encoder = new TextEncoder();
const MIN_API_TOKEN_LENGTH = 32;
const PLACEHOLDER_PREFIX = "REPLACE_WITH_";

export type ApiAuthMode = "bearer" | "demo" | "session";
export type ProjectRole = "owner" | "admin" | "member";

type TokenAuthContext = {
  ok: true;
  projects: ReadonlySet<string>;
  mode: "bearer" | "demo";
};

export type SessionAuthContext = {
  ok: true;
  mode: "session";
  projects: ReadonlySet<string>;
  projectRoles: ReadonlyMap<string, ProjectRole>;
  hostedSession: HostedSession;
  globalAdmin: boolean;
};

export type ApiAuthContext = TokenAuthContext | SessionAuthContext;

export type ApiRouteName =
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

const DEMO_READABLE_ROUTES = new Set<ApiRouteName>([
  "sessions_list",
  "session_heads",
  "session_state",
  "project_stats",
  "project_live",
  "manifest",
  "segment",
  "live_ticket",
]);

const MANAGER_ROUTES = new Set<ApiRouteName>([
  "project_config_write",
  "project_keys",
  "public_page_read",
  "public_page_write",
]);

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

  // An explicit Authorization header is always treated as an attempt to use
  // the local token. A bad token must never fall through to a demo or session.
  if (header !== null) {
    if (authMode !== "token") {
      return { ok: false, status: 401, error: "unauthorized" };
    }
    return checkBearerAuth(header, env);
  }

  const demo = readDemoConfig(env);
  if (demo !== null && routeProjectId === demo.projectId) {
    return { ok: true, projects: new Set([demo.projectId]), mode: "demo" };
  }

  if (authMode === "unavailable") {
    return { ok: false, status: 503, error: "auth_not_configured" };
  }

  if (authMode === "token") {
    if (readApiAuthConfig(env) === null) {
      return { ok: false, status: 503, error: "auth_not_configured" };
    }
    return { ok: false, status: 401, error: "unauthorized" };
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
  if (auth.mode === "demo" && !DEMO_READABLE_ROUTES.has(route)) {
    return jsonError("unauthorized", 401);
  }

  if (!auth.projects.has(projectId)) {
    return jsonError("forbidden", 403);
  }

  if (auth.mode === "session" && MANAGER_ROUTES.has(route)) {
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

function checkBearerAuth(
  header: string,
  env: Env,
): TokenAuthContext | { ok: false; status: 401 | 503; error: string } {
  const apiAuth = readApiAuthConfig(env);
  if (apiAuth === null) {
    return { ok: false, status: 503, error: "auth_not_configured" };
  }

  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const expected = encoder.encode(apiAuth.token);
  const actual = encoder.encode(header.slice(prefix.length));
  if (!timingSafeEqual(expected, actual)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  return { ok: true, projects: apiAuth.projects, mode: "bearer" };
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

function readApiAuthConfig(env: Env): { token: string; projects: ReadonlySet<string> } | null {
  const token = readApiToken(env);
  const projects = readApiProjectIds(env);
  if (token === null || projects === null) {
    return null;
  }

  return { token, projects };
}

function readApiToken(env: Pick<Env, "DEV_API_TOKEN">): string | null {
  const token = env.DEV_API_TOKEN;
  if (typeof token !== "string") {
    return null;
  }

  if (token.length < MIN_API_TOKEN_LENGTH || token.trim() !== token) {
    return null;
  }

  return token;
}

function readApiProjectIds(env: Pick<Env, "DEV_API_PROJECT_IDS">): ReadonlySet<string> | null {
  const value = env.DEV_API_PROJECT_IDS;
  if (typeof value !== "string") {
    return null;
  }

  const projects = new Set<string>();
  for (const part of value.split(",")) {
    const projectId = part.trim();
    if (projectId.length === 0 || !isValidPathId(projectId)) {
      return null;
    }
    projects.add(projectId);
  }

  return projects.size === 0 ? null : projects;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
