import { redirect } from "@tanstack/react-router";
import {
  ApiError,
  accountProjects,
  accountQueryKey,
  bootstrapAccount,
  canManageProject,
  fetchAccount,
  findAccountProject,
  getApiToken,
} from "./api";
import { isDemoPath } from "./demo-mode";
import { queryClient } from "./query";
import { defaultProjectId, loginSearch } from "./routes";

interface RouteLocation {
  href: string;
  pathname: string;
}

export function requireProjectToken(location: RouteLocation): void {
  if (isDemoPath(location.pathname) || getApiToken() !== null) return;
  throw redirect({
    to: "/login",
    search: loginSearch(undefined, location.href),
    replace: true,
  });
}

export async function requireProjectAccess(
  location: RouteLocation,
  projectId: string,
): Promise<void> {
  if (isDemoPath(location.pathname) || getApiToken() !== null) return;

  let account;
  try {
    account = await queryClient.ensureQueryData({
      queryKey: accountQueryKey,
      queryFn: fetchAccount,
      staleTime: 30_000,
    });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 503)) {
      throw redirect({
        to: "/login",
        search: loginSearch(error.status === 503 ? "auth_unavailable" : undefined, location.href),
        replace: true,
      });
    }
    throw error;
  }

  if (findAccountProject(account, projectId) === undefined) {
    throw redirect({ to: "/projects", replace: true });
  }
}

export async function requireProjectManager(
  location: RouteLocation,
  projectId: string,
): Promise<void> {
  await requireProjectAccess(location, projectId);
  if (getApiToken() !== null) return;

  const account =
    queryClient.getQueryData<Awaited<ReturnType<typeof fetchAccount>>>(accountQueryKey);
  const project = findAccountProject(account, projectId);
  if (!canManageProject(project)) {
    throw redirect({
      to: "/projects/$projectId/overview",
      params: { projectId },
      replace: true,
    });
  }
}

export async function requireAdminAccess(location: RouteLocation): Promise<void> {
  let account;
  try {
    account = await queryClient.ensureQueryData({
      queryKey: accountQueryKey,
      queryFn: fetchAccount,
      staleTime: 30_000,
    });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 503)) {
      throw redirect({
        to: "/login",
        search: loginSearch(error.status === 503 ? "auth_unavailable" : undefined, location.href),
        replace: true,
      });
    }
    throw error;
  }

  if (!account.isAdmin) {
    throw redirect({ to: "/projects", replace: true });
  }
}

export async function openProjectsHome(location: RouteLocation): Promise<void> {
  if (getApiToken() !== null) {
    throw redirect({
      to: "/projects/$projectId/overview",
      params: { projectId: defaultProjectId },
      replace: true,
    });
  }

  let account;
  try {
    account = await queryClient.ensureQueryData({
      queryKey: accountQueryKey,
      queryFn: fetchAccount,
      staleTime: 30_000,
    });
    if (account.workspaces.length === 0) {
      account = await bootstrapAccount();
      queryClient.setQueryData(accountQueryKey, account);
    }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 503)) {
      throw redirect({
        to: "/login",
        search: loginSearch(error.status === 503 ? "auth_unavailable" : undefined, location.href),
        replace: true,
      });
    }
    throw error;
  }

  const project = accountProjects(account)[0];
  if (project !== undefined) {
    throw redirect({
      to: "/projects/$projectId/overview",
      params: { projectId: project.id },
      replace: true,
    });
  }
}
