import { redirect } from "@tanstack/react-router";
import {
  ApiError,
  accountQueryKey,
  bootstrapAccount,
  fetchAccount,
  fetchInstallStatus,
} from "./api";
import {
  accountProjects,
  canManageProject,
  currentDashboardScope,
  decideAdminRoute,
  decideProjectRoute,
  decideProjectsHome,
  type ProjectRouteDecision,
} from "./dashboard-access";
import { queryClient } from "./query";
import { loginSearch } from "./routes";

interface RouteLocation {
  href: string;
  pathname: string;
}

type Account = Awaited<ReturnType<typeof fetchAccount>>;

export function requireProjectAccess(location: RouteLocation, projectId: string): Promise<void> {
  return requireProjectRoute(location, projectId, "view");
}

export function requireProjectManager(location: RouteLocation, projectId: string): Promise<void> {
  return requireProjectRoute(location, projectId, "manage");
}

export async function requireAdminAccess(location: RouteLocation): Promise<void> {
  let decision = decideAdminRoute();
  if (decision.action === "load-account") {
    const account = await loadAccountOrRedirect(location);
    decision = decideAdminRoute(account);
  }

  if (decision.action !== "allow") {
    throw redirect({ to: "/projects", replace: true });
  }
}

export async function openProjectsHome(location: RouteLocation): Promise<void> {
  let account: Account | undefined;
  let decision = decideProjectsHome({});

  if (decision.action === "load-account") {
    account = await loadAccountOrRedirect(location);
    decision = decideProjectsHome({ account });
  }
  if (decision.action === "bootstrap-account") {
    account = await bootstrapAccountOrRedirect(location);
    decision = decideProjectsHome({ account });
  }
  if (decision.action === "check-activation") {
    decision = decideProjectsHome({
      account,
      checkedActivation: true,
      hasFirstEvent: await hasProjectFirstEvent(decision.projectId),
    });
  }
  if (decision.action === "activate-project") {
    throw redirect({ to: "/onboarding/website", replace: true });
  }
  if (decision.action === "open-project") {
    throw redirect({
      to: "/projects/$projectId/overview",
      params: { projectId: decision.projectId },
      replace: true,
    });
  }
}

/**
 * Guards the activation flow. It needs a signed-in account with a project the
 * visitor can manage — activation writes the project name, its origin
 * allowlist, and a recorder key. Already-activated projects are not bounced
 * out: reaching the last step and seeing the recorder connected is the flow's
 * ending, and revisiting it is harmless.
 */
export async function requireActivationAccess(location: RouteLocation): Promise<void> {
  const account = await loadAccountOrRedirect(location);
  const project = accountProjects(account)[0];
  // Same manageability rule `decideProjectsHome` applies, so the two cannot
  // disagree and bounce a visitor between /projects and /onboarding forever.
  if (project === undefined || !canManageProject(project)) {
    throw redirect({ to: "/projects", replace: true });
  }
}

/**
 * Whether a project has ever recorded anything, or `undefined` when the check
 * itself failed.
 *
 * An unreachable presence registry must NOT be read as "not activated yet".
 * Activation's first step replaces the project's origin allowlist, so diverting
 * a project that is already live — because Presence happened to return 503 —
 * would let a routine outage walk an owner into overwriting a working install.
 * Uncertainty therefore means "leave them where they were going".
 */
async function hasProjectFirstEvent(projectId: string): Promise<boolean | undefined> {
  try {
    const status = await queryClient.ensureQueryData({
      queryKey: ["install-status", projectId],
      queryFn: () => fetchInstallStatus(projectId),
      staleTime: 30_000,
    });
    return status.firstEventAt !== null;
  } catch {
    return undefined;
  }
}

async function requireProjectRoute(
  location: RouteLocation,
  projectId: string,
  requirement: "view" | "manage",
): Promise<void> {
  const scope = currentDashboardScope(location.pathname);
  let decision = decideProjectRoute({ projectId, requirement, scope });

  if (decision.action === "load-account") {
    const account = await loadAccountOrRedirect(location);
    decision = decideProjectRoute({ account, projectId, requirement, scope });
  }
  applyProjectDecision(decision, projectId);
}

function applyProjectDecision(decision: ProjectRouteDecision, projectId: string): void {
  if (decision.action === "allow") return;
  if (decision.action === "redirect-projects") {
    throw redirect({ to: "/projects", replace: true });
  }
  if (decision.action === "redirect-overview") {
    throw redirect({
      to: "/projects/$projectId/overview",
      params: { projectId },
      replace: true,
    });
  }
  throw new Error("Project access could not be decided.");
}

async function loadAccountOrRedirect(location: RouteLocation): Promise<Account> {
  try {
    return await queryClient.ensureQueryData({
      queryKey: accountQueryKey,
      queryFn: fetchAccount,
      staleTime: 30_000,
    });
  } catch (error) {
    redirectForAccountError(error, location);
  }
}

async function bootstrapAccountOrRedirect(location: RouteLocation): Promise<Account> {
  try {
    const account = await bootstrapAccount();
    queryClient.setQueryData(accountQueryKey, account);
    return account;
  } catch (error) {
    redirectForAccountError(error, location);
  }
}

function redirectForAccountError(error: unknown, location: RouteLocation): never {
  if (error instanceof ApiError && (error.status === 401 || error.status === 503)) {
    throw redirect({
      to: "/login",
      search: loginSearch(error.status === 503 ? "auth_unavailable" : undefined, location.href),
      replace: true,
    });
  }
  throw error;
}
