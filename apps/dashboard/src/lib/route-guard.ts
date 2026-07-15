import { redirect } from "@tanstack/react-router";
import { ApiError, accountQueryKey, bootstrapAccount, fetchAccount } from "./api";
import {
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
  if (decision.action === "open-project") {
    throw redirect({
      to: "/projects/$projectId/overview",
      params: { projectId: decision.projectId },
      replace: true,
    });
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
