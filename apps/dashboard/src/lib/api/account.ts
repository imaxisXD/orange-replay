import {
  decodeAccountResponse,
  decodeAuthConfigResponse,
  decodeCreatedProjectKeyResponse,
  decodeProjectKeyResponse,
  type AccountProject as SharedAccountProject,
  type AccountResponse as SharedAccountResponse,
  type AccountUser as SharedAccountUser,
  type AccountWorkspace as SharedAccountWorkspace,
  type CreatedProjectKeyResponse as SharedCreatedProjectKeyResponse,
  type ProjectKeyAudit as SharedProjectKeyAudit,
  type ProjectKeysResponse as SharedProjectKeysResponse,
} from "@orange-replay/shared";
import type { DashboardProjectRole, ServerAuthMode } from "../dashboard-access";
import { encodePathPart, requestJson } from "./client";

export type AuthMode = ServerAuthMode;
export type WorkspaceRole = DashboardProjectRole;

export type AuthConfigResponse = import("@orange-replay/shared").AuthConfigResponse;
export type AccountUser = SharedAccountUser;
export type AccountProject = SharedAccountProject;
export type AccountWorkspace = SharedAccountWorkspace;
export type AccountResponse = SharedAccountResponse;
export type ProjectKeyAudit = SharedProjectKeyAudit;
export type ProjectKeysResponse = SharedProjectKeysResponse;
export type CreatedProjectKeyResponse = SharedCreatedProjectKeyResponse;

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
    decode: decodeAuthConfigResponse,
    redirectOnAuthError: false,
  });
}

export async function fetchAccount(): Promise<AccountResponse> {
  return requestJson<AccountResponse>("/api/v1/account", {
    auth: true,
    decode: decodeAccountResponse,
    redirectOnAuthError: false,
  });
}

export async function bootstrapAccount(): Promise<AccountResponse> {
  return requestJson<AccountResponse>("/api/v1/account/bootstrap", {
    auth: true,
    decode: decodeAccountResponse,
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
      decode: decodeCreatedProjectKeyResponse,
      method: "POST",
    },
  );
}

export async function revokeProjectKey(
  projectId: string,
  keyId: string,
): Promise<import("@orange-replay/shared").ProjectKeyResponse> {
  return requestJson<import("@orange-replay/shared").ProjectKeyResponse>(
    `/api/v1/projects/${encodePathPart(projectId)}/keys/${encodePathPart(keyId)}`,
    {
      auth: true,
      decode: decodeProjectKeyResponse,
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
