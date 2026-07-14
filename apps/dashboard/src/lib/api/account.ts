import { encodePathPart, requestJson } from "./client";

export type AuthMode = "github" | "token" | "unavailable";
export type WorkspaceRole = "owner" | "admin" | "member";

export interface AuthConfigResponse {
  mode: AuthMode;
}

export interface AccountUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string;
}

export interface AccountProject {
  id: string;
  name: string;
  role: WorkspaceRole;
}

export interface AccountWorkspace {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  projects: AccountProject[];
}

export interface AccountResponse {
  user: AccountUser;
  workspaces: AccountWorkspace[];
  isAdmin: boolean;
}

export interface ProjectKeyAudit {
  id: string;
  name: string;
  active: boolean;
  createdAt: number;
  createdBy: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  keyHashPrefix: string;
}

export interface ProjectKeysResponse {
  keys: ProjectKeyAudit[];
}

export interface CreatedProjectKeyResponse {
  key: ProjectKeyAudit;
  secret: string;
}

export interface AdminStatsResponse {
  users: number;
  newUsers: number;
  workspaces: number;
  projects: number;
  activeKeys: number;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  banned: boolean;
  banReason: string | null;
  createdAt: number;
  lastSignedInAt: number | null;
  workspaceCount: number;
}

export interface AdminUsersResponse {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminUserSearch {
  limit?: number;
  offset?: number;
  search?: string;
}

export const authConfigQueryKey = ["auth-config"] as const;
export const accountQueryKey = ["account"] as const;

export async function fetchAuthConfig(): Promise<AuthConfigResponse> {
  return requestJson<AuthConfigResponse>("/api/v1/auth/config", {
    auth: false,
    redirectOnAuthError: false,
  });
}

export async function fetchAccount(): Promise<AccountResponse> {
  return requestJson<AccountResponse>("/api/v1/account", {
    auth: true,
    redirectOnAuthError: false,
  });
}

export async function bootstrapAccount(): Promise<AccountResponse> {
  return requestJson<AccountResponse>("/api/v1/account/bootstrap", {
    auth: true,
    method: "POST",
    redirectOnAuthError: false,
  });
}

export async function createProjectKey(
  projectId: string,
  name: string,
): Promise<CreatedProjectKeyResponse> {
  return requestJson<CreatedProjectKeyResponse>(
    `/api/v1/projects/${encodePathPart(projectId)}/keys`,
    {
      auth: true,
      body: { name },
      method: "POST",
    },
  );
}

export async function revokeProjectKey(
  projectId: string,
  keyId: string,
): Promise<{ key: ProjectKeyAudit }> {
  return requestJson<{ key: ProjectKeyAudit }>(
    `/api/v1/projects/${encodePathPart(projectId)}/keys/${encodePathPart(keyId)}`,
    {
      auth: true,
      method: "DELETE",
    },
  );
}

export async function fetchAdminStats(): Promise<AdminStatsResponse> {
  return requestJson<AdminStatsResponse>("/api/v1/admin/stats", { auth: true });
}

export async function fetchAdminUsers(search: AdminUserSearch = {}): Promise<AdminUsersResponse> {
  const query = new URLSearchParams();
  if (search.limit !== undefined) query.set("limit", String(search.limit));
  if (search.offset !== undefined) query.set("offset", String(search.offset));
  if (search.search !== undefined && search.search.length > 0) {
    query.set("search", search.search);
  }
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return requestJson<AdminUsersResponse>(`/api/v1/admin/users${suffix}`, { auth: true });
}

export function accountProjects(account: AccountResponse): AccountProject[] {
  return account.workspaces.flatMap((workspace) => workspace.projects);
}

export function findAccountProject(
  account: AccountResponse | undefined,
  projectId: string,
): AccountProject | undefined {
  return account?.workspaces
    .flatMap((workspace) => workspace.projects)
    .find((project) => project.id === projectId);
}

export function canManageProject(project: AccountProject | undefined): boolean {
  return project?.role === "owner" || project?.role === "admin";
}
