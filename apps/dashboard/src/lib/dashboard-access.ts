import type { AccountProjectRole, AuthMode } from "@orange-replay/shared";
import { authClient } from "./auth-client";
import { queryClient } from "./query";

export type ServerAuthMode = AuthMode;
export type DashboardAccessScope = "private" | "demo";
export type DashboardAccessAdapter = "hosted-cookie" | "demo" | "unavailable";
export type DashboardProjectRole = AccountProjectRole;

export interface DashboardAccess {
  adapter: DashboardAccessAdapter;
  isDemo: boolean;
  needsAccount: boolean;
}

export type AuthRedirectReason = "unauthorized" | "auth_unavailable";

export interface AuthRedirectEvent {
  reason: AuthRedirectReason;
  status: 401 | 503;
}

interface AccessProject {
  id: string;
  role: DashboardProjectRole;
}

interface AccessAccount<TProject extends AccessProject = AccessProject> {
  isAdmin: boolean;
  workspaces: readonly { projects: readonly TProject[] }[];
}

interface HostedSignInClient {
  signIn: {
    social: (options: {
      provider: "github";
      callbackURL: string;
      newUserCallbackURL: string;
      errorCallbackURL: string;
    }) => Promise<{ error?: unknown }>;
  };
}

export interface HostedSignOutClient {
  signOut: () => Promise<{ error?: unknown }>;
}

type AuthRedirectHandler = (event: AuthRedirectEvent) => void;

let authRedirectHandler: AuthRedirectHandler = defaultAuthRedirectHandler;

export function readDashboardAccess(
  scope: DashboardAccessScope = currentDashboardScope(),
  authMode?: ServerAuthMode,
): DashboardAccess {
  if (scope === "demo") {
    return access("demo");
  }

  if (authMode === "unavailable") {
    return access("unavailable");
  }
  return access("hosted-cookie");
}

export function dashboardRequestAccess(
  options: { scope?: DashboardAccessScope } = {},
): DashboardAccess {
  const scope = options.scope ?? currentDashboardScope();
  return readDashboardAccess(scope);
}

export function dashboardPlayerAccess(isDemo: boolean): DashboardAccess {
  return readDashboardAccess(isDemo ? "demo" : "private");
}

export function clearDashboardAccess(): void {
  queryClient.clear();
}

export async function startGithubSignIn(
  options: {
    callbackURL: string;
    errorCallbackURL: string;
    newUserCallbackURL: string;
  },
  client: HostedSignInClient = authClient,
): Promise<void> {
  clearDashboardAccess();
  const result = await client.signIn.social({ provider: "github", ...options });
  if (result.error !== null && result.error !== undefined) throw result.error;
}

export async function signOutDashboardAccess(
  client: HostedSignOutClient = authClient,
): Promise<void> {
  const result = await client.signOut();
  if (result.error !== null && result.error !== undefined) throw result.error;
  clearDashboardAccess();
}

export function readDashboardAccessError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

export function setAuthRedirectHandler(handler: AuthRedirectHandler): () => void {
  const previousHandler = authRedirectHandler;
  authRedirectHandler = handler;
  return () => {
    authRedirectHandler = previousHandler;
  };
}

export function handleDashboardAuthFailure(status: number, code?: string): boolean {
  const event = authRedirectEvent(status, code);
  if (event === null) return false;
  clearDashboardAccess();
  authRedirectHandler(event);
  return true;
}

export function currentDashboardScope(pathname = currentPathname()): DashboardAccessScope {
  return isDemoPath(pathname) ? "demo" : "private";
}

export function isDemoPath(pathname = currentPathname()): boolean {
  return pathname === "/demo" || pathname.startsWith("/demo/");
}

export function accountProjects<TProject extends AccessProject>(
  account: AccessAccount<TProject>,
): TProject[] {
  return account.workspaces.flatMap((workspace) => [...workspace.projects]);
}

export function findAccountProject<TProject extends AccessProject>(
  account: AccessAccount<TProject> | undefined,
  projectId: string,
): TProject | undefined {
  return account === undefined
    ? undefined
    : accountProjects(account).find((project) => project.id === projectId);
}

export function canManageProject(project: AccessProject | undefined): boolean {
  return project?.role === "owner" || project?.role === "admin";
}

export type ProjectRouteDecision =
  | { action: "allow" }
  | { action: "load-account" }
  | { action: "redirect-projects" }
  | { action: "redirect-overview" };

export function decideProjectRoute<TProject extends AccessProject>(options: {
  account?: AccessAccount<TProject>;
  projectId: string;
  requirement: "view" | "manage";
  scope: DashboardAccessScope;
}): ProjectRouteDecision {
  if (readDashboardAccess(options.scope).adapter === "demo") {
    return options.requirement === "view" ? { action: "allow" } : { action: "redirect-projects" };
  }
  if (options.account === undefined) return { action: "load-account" };

  const project = findAccountProject(options.account, options.projectId);
  if (project === undefined) return { action: "redirect-projects" };
  if (options.requirement === "manage" && !canManageProject(project)) {
    return { action: "redirect-overview" };
  }
  return { action: "allow" };
}

export type ProjectsHomeDecision =
  | { action: "load-account" }
  | { action: "bootstrap-account" }
  | { action: "open-project"; projectId: string }
  | { action: "show-empty" };

export function decideProjectsHome<TProject extends AccessProject>(options: {
  account?: AccessAccount<TProject>;
}): ProjectsHomeDecision {
  if (options.account === undefined) return { action: "load-account" };
  if (options.account.workspaces.length === 0) return { action: "bootstrap-account" };
  const project = accountProjects(options.account)[0];
  return project === undefined
    ? { action: "show-empty" }
    : { action: "open-project", projectId: project.id };
}

export type AdminRouteDecision =
  | { action: "load-account" }
  | { action: "allow" }
  | { action: "redirect-projects" };

export function decideAdminRoute(account?: AccessAccount): AdminRouteDecision {
  if (account === undefined) return { action: "load-account" };
  return account.isAdmin ? { action: "allow" } : { action: "redirect-projects" };
}

function access(adapter: DashboardAccessAdapter): DashboardAccess {
  return {
    adapter,
    isDemo: adapter === "demo",
    needsAccount: adapter === "hosted-cookie",
  };
}

function authRedirectEvent(status: number, code?: string): AuthRedirectEvent | null {
  if (status === 401) return { status, reason: "unauthorized" };
  if (status === 503 && code === "auth_not_configured") {
    return { status, reason: "auth_unavailable" };
  }
  return null;
}

function defaultAuthRedirectHandler(event: AuthRedirectEvent): void {
  const reason = encodeURIComponent(event.reason);
  const target = `/login?reason=${reason}`;
  if (window.location.pathname !== "/login") window.location.assign(target);
}

function currentPathname(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname;
}
