import type {
  ProjectConfigUpdate,
  ProjectKeysResponse,
  SessionManifest,
  StoredProjectConfig,
} from "@orange-replay/shared/types";

export const tokenStorageKey = "or:token";

export interface SessionListItem {
  session_id: string;
  project_id: string;
  org_id: string;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  entry_url: string | null;
  url_count: number;
  clicks: number;
  errors: number;
  rages: number;
  navs: number;
  bytes: number;
  segment_count: number;
  flags: number;
  manifest_key: string;
  expires_at: number;
}

export interface ListSessionsParams {
  before?: string | null;
  country?: string;
  hasErrors?: boolean;
  limit?: number;
  minDurationMs?: number;
}

export interface ListSessionsResponse {
  sessions: SessionListItem[];
  nextBefore: string | null;
}

export interface LiveSessionItem {
  session_id: string;
  started_at: number;
  last_seen: number;
  entry_url: string | null;
  country: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  duration_ms: number;
}

export interface LiveSessionsResponse {
  sessions: LiveSessionItem[];
}

export interface HealthResponse {
  ok: boolean;
}

export interface InstallStatusResponse {
  firstEventAt: number | null;
}

export type AuthRedirectReason = "unauthorized" | "auth_unavailable";

export interface AuthRedirectEvent {
  reason: AuthRedirectReason;
  status: 401 | 503;
}

type AuthRedirectHandler = (event: AuthRedirectEvent) => void;

let authRedirectHandler: AuthRedirectHandler = defaultAuthRedirectHandler;

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function setApiToken(token: string): void {
  window.localStorage.setItem(tokenStorageKey, token);
}

export function getApiToken(): string | null {
  return window.localStorage.getItem(tokenStorageKey);
}

export function clearApiToken(): void {
  window.localStorage.removeItem(tokenStorageKey);
}

export function setAuthRedirectHandler(handler: AuthRedirectHandler): () => void {
  const previousHandler = authRedirectHandler;
  authRedirectHandler = handler;
  return () => {
    authRedirectHandler = previousHandler;
  };
}

export async function health(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/v1/health", { auth: false });
}

export async function checkApiToken(token: string): Promise<void> {
  await requestJson<unknown>("/api/v1/projects/p1/sessions?limit=1", {
    auth: true,
    redirectOnAuthError: false,
    token,
  });
}

export async function listSessions(
  projectId: string,
  params: ListSessionsParams = {},
): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>(buildSessionListUrl(projectId, params), { auth: true });
}

export async function fetchLiveSessions(projectId: string): Promise<LiveSessionsResponse> {
  return requestJson<LiveSessionsResponse>(`/api/v1/projects/${encodePathPart(projectId)}/live`, {
    auth: true,
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
  });
}

export async function fetchInstallStatus(projectId: string): Promise<InstallStatusResponse> {
  return requestJson<InstallStatusResponse>(
    `/api/v1/projects/${encodePathPart(projectId)}/install-status`,
    { auth: true },
  );
}

export async function getManifest(projectId: string, sessionId: string): Promise<SessionManifest> {
  const path = `/api/v1/projects/${encodePathPart(projectId)}/sessions/${encodePathPart(
    sessionId,
  )}/manifest`;
  return requestJson<SessionManifest>(path, { auth: true });
}

export function segmentUrl(projectId: string, sessionId: string, name: string): string {
  return `/api/v1/projects/${encodePathPart(projectId)}/sessions/${encodePathPart(
    sessionId,
  )}/segments/${encodePathPart(name)}`;
}

export function buildSessionListUrl(projectId: string, params: ListSessionsParams = {}): string {
  const query = new URLSearchParams();

  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.before) query.set("before", params.before);
  if (params.country?.trim()) query.set("country", params.country.trim().toUpperCase());
  if (params.hasErrors) query.set("has_errors", "1");
  if (params.minDurationMs !== undefined) {
    query.set("min_duration_ms", String(params.minDurationMs));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `/api/v1/projects/${encodePathPart(projectId)}/sessions${suffix}`;
}

interface RequestOptions {
  auth: boolean;
  body?: unknown;
  method?: string;
  redirectOnAuthError?: boolean;
  token?: string;
}

async function requestJson<T>(path: string, options: RequestOptions): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  const token = options.token ?? getApiToken();

  if (options.auth && token !== null && token.length > 0) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const init: RequestInit = { headers };
  if (options.method !== undefined) init.method = options.method;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError(readErrorMessage(error, "Could not reach the API."), 0, "network_error");
  }

  if (
    options.redirectOnAuthError !== false &&
    (response.status === 401 || response.status === 503)
  ) {
    handleAuthRedirect(response.status);
  }

  if (!response.ok) {
    const code = await readErrorCode(response);
    throw new ApiError(
      code ?? `Request failed with status ${response.status}.`,
      response.status,
      code,
    );
  }

  return (await response.json()) as T;
}

function handleAuthRedirect(status: 401 | 503): void {
  const event: AuthRedirectEvent = {
    status,
    reason: status === 503 ? "auth_unavailable" : "unauthorized",
  };
  clearApiToken();
  authRedirectHandler(event);
}

function defaultAuthRedirectHandler(event: AuthRedirectEvent): void {
  const reason = encodeURIComponent(event.reason);
  const target = `/login?reason=${reason}`;
  if (window.location.pathname !== "/login") {
    window.location.assign(target);
  }
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}
