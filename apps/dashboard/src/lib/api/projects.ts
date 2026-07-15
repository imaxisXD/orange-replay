import type {
  ProjectConfigUpdate,
  PublicPageSettings,
  PublicPageSettingsUpdate,
  StoredProjectConfig,
} from "@orange-replay/shared/types";
import { decodeProjectKeysResponse, type ProjectKeysResponse } from "@orange-replay/shared";
import type { DemoWorkspaceResponse } from "../demo-mode";
import { requestJson, encodePathPart } from "./client";

export interface HealthResponse {
  ok: boolean;
}

export interface InstallStatusResponse {
  firstEventAt: number | null;
}

export async function health(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/v1/health", { auth: false });
}

export async function fetchDemoWorkspace(
  options: { signal?: AbortSignal } = {},
): Promise<DemoWorkspaceResponse> {
  return requestJson<DemoWorkspaceResponse>("/api/v1/demo", {
    auth: false,
    redirectOnAuthError: false,
    signal: options.signal,
  });
}

export async function fetchProjectConfig(projectId: string): Promise<StoredProjectConfig> {
  return requestJson<StoredProjectConfig>(`/api/v1/projects/${encodePathPart(projectId)}/config`, {
    auth: true,
  });
}

export async function saveProjectConfig(
  projectId: string,
  update: ProjectConfigUpdate,
): Promise<StoredProjectConfig> {
  return requestJson<StoredProjectConfig>(`/api/v1/projects/${encodePathPart(projectId)}/config`, {
    auth: true,
    method: "PUT",
    body: update,
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
    { auth: true },
  );
}

export async function fetchPublicPageSettings(projectId: string): Promise<PublicPageSettings> {
  return requestJson<PublicPageSettings>(
    `/api/v1/projects/${encodePathPart(projectId)}/public-page`,
    { auth: true },
  );
}

export async function savePublicPageSettings(
  projectId: string,
  update: PublicPageSettingsUpdate,
): Promise<PublicPageSettings> {
  return requestJson<PublicPageSettings>(
    `/api/v1/projects/${encodePathPart(projectId)}/public-page`,
    { auth: true, method: "PUT", body: update },
  );
}
