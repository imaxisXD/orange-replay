import { isDemoPath } from "../demo-mode";
import { queryClient } from "../query";

export const tokenStorageKey = "or:token";

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
  const previousToken = getApiToken();
  window.localStorage.setItem(tokenStorageKey, token);
  if (previousToken !== token) {
    queryClient.clear();
  }
}

export function getApiToken(): string | null {
  return window.localStorage.getItem(tokenStorageKey);
}

export function clearApiToken(): void {
  window.localStorage.removeItem(tokenStorageKey);
  queryClient.clear();
}

export function setAuthRedirectHandler(handler: AuthRedirectHandler): () => void {
  const previousHandler = authRedirectHandler;
  authRedirectHandler = handler;
  return () => {
    authRedirectHandler = previousHandler;
  };
}

export interface RequestOptions {
  auth: boolean;
  body?: unknown;
  method?: string;
  redirectOnAuthError?: boolean;
  signal?: AbortSignal;
  token?: string;
}

export async function requestJson<T>(path: string, options: RequestOptions): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  const demoMode = isDemoPath();
  const token = demoMode ? null : (options.token ?? getApiToken());

  if (!demoMode && options.auth && token !== null && token.length > 0) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const init: RequestInit = { headers };
  if (options.signal !== undefined) init.signal = options.signal;
  if (options.method !== undefined) init.method = options.method;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError(
      readErrorMessage(error, "Could not reach the API. Check your connection and try again."),
      0,
      "network_error",
    );
  }

  if (!response.ok) {
    const code = await readErrorCode(response);
    if (
      !demoMode &&
      options.redirectOnAuthError !== false &&
      shouldRedirectForAuth(response.status, code)
    ) {
      handleAuthRedirect(response.status, code);
    }
    throw new ApiError(
      code ?? `Request failed with status ${response.status}.`,
      response.status,
      code,
    );
  }

  return (await response.json()) as T;
}

export function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

function shouldRedirectForAuth(status: number, code: string | undefined): status is 401 | 503 {
  return status === 401 || (status === 503 && code === "auth_not_configured");
}

function handleAuthRedirect(status: 401 | 503, code?: string): void {
  const event: AuthRedirectEvent = {
    status,
    reason: status === 503 && code === "auth_not_configured" ? "auth_unavailable" : "unauthorized",
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
