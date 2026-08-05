import type {
  ProjectConfigUpdate,
  PublicPageSettings,
  PublicPageSettingsUpdate,
  StoredProjectConfig,
} from "@orange-replay/shared/types";
import {
  decodeDemoWorkspaceResponse,
  decodeInstallStatusResponse,
  decodeProjectKeysResponse,
  decodeProjectSummary,
  decodePublicPageSettings,
  publicPageSettingsUpdateSchema,
  storedProjectConfigSchema,
  type ProjectKeysResponse,
  type ProjectSummary,
  type InstallStatusResponse as SharedInstallStatusResponse,
} from "@orange-replay/shared";
import { projectConfigUpdateSchema } from "@orange-replay/shared/project-config-update";
import type { DemoWorkspaceResponse } from "../demo-mode";
import { requestJson, encodePathPart } from "./client";

export interface HealthResponse {
  ok: boolean;
}

export type InstallStatusResponse = SharedInstallStatusResponse;

export async function health(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/v1/health", {
    auth: false,
    decode: decodeHealthResponse,
  });
}

export async function fetchDemoWorkspace(
  options: { signal?: AbortSignal } = {},
): Promise<DemoWorkspaceResponse> {
  return requestJson<DemoWorkspaceResponse>("/api/v1/demo", {
    auth: false,
    decode: decodeDemoWorkspaceResponse,
    redirectOnAuthError: false,
    signal: options.signal,
  });
}

export async function fetchProjectConfig(projectId: string): Promise<StoredProjectConfig> {
  return requestJson<StoredProjectConfig>(`/api/v1/projects/${encodePathPart(projectId)}/config`, {
    auth: true,
    decode: decodeStoredProjectConfig,
  });
}

export async function saveProjectConfig(
  projectId: string,
  update: ProjectConfigUpdate,
): Promise<StoredProjectConfig> {
  const body = projectConfigUpdateSchema.parse(update);
  return requestJson<StoredProjectConfig>(`/api/v1/projects/${encodePathPart(projectId)}/config`, {
    auth: true,
    body,
    decode: decodeStoredProjectConfig,
    method: "PUT",
  });
}

export async function renameProject(projectId: string, name: string): Promise<ProjectSummary> {
  return requestJson<ProjectSummary>(`/api/v1/projects/${encodePathPart(projectId)}`, {
    auth: true,
    body: { name },
    decode: decodeProjectSummary,
    method: "PATCH",
  });
}

export async function fetchProjectKeys(projectId: string): Promise<ProjectKeysResponse> {
  return requestJson<ProjectKeysResponse>(`/api/v1/projects/${encodePathPart(projectId)}/keys`, {
    auth: true,
    decode: decodeProjectKeysResponse,
  });
}

export async function fetchInstallStatus(projectId: string): Promise<InstallStatusResponse> {
  return requestJson<InstallStatusResponse>(
    `/api/v1/projects/${encodePathPart(projectId)}/install-status`,
    { auth: true, decode: decodeInstallStatusResponse },
  );
}

export async function fetchPublicPageSettings(projectId: string): Promise<PublicPageSettings> {
  return requestJson<PublicPageSettings>(
    `/api/v1/projects/${encodePathPart(projectId)}/public-page`,
    { auth: true, decode: decodePublicPageSettings },
  );
}

export async function savePublicPageSettings(
  projectId: string,
  update: PublicPageSettingsUpdate,
): Promise<PublicPageSettings> {
  const body = publicPageSettingsUpdateSchema.parse(update);
  return requestJson<PublicPageSettings>(
    `/api/v1/projects/${encodePathPart(projectId)}/public-page`,
    { auth: true, body, decode: decodePublicPageSettings, method: "PUT" },
  );
}

function decodeHealthResponse(value: unknown): HealthResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as { ok?: unknown }).ok !== "boolean"
  ) {
    throw new Error("health response must contain one boolean ok field");
  }
  return { ok: (value as { ok: boolean }).ok };
}

function decodeStoredProjectConfig(value: unknown): StoredProjectConfig {
  return storedProjectConfigSchema.parse(value);
}
