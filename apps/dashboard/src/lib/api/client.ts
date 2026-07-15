import {
  dashboardRequestAccess,
  handleDashboardAuthFailure,
  type DashboardAccessScope,
} from "../dashboard-access";

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

export type ResponseDecoder<Value> = (value: unknown) => Value;

export interface RequestOptions<Value = unknown> {
  auth: boolean;
  body?: unknown;
  decode?: ResponseDecoder<Value>;
  method?: string;
  redirectOnAuthError?: boolean;
  scope?: DashboardAccessScope;
  signal?: AbortSignal;
}

export async function requestJson<T>(path: string, options: RequestOptions<T>): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  const requestAccess = dashboardRequestAccess({ scope: options.scope });

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
    if (!requestAccess.isDemo && options.redirectOnAuthError !== false) {
      handleDashboardAuthFailure(response.status, code);
    }
    throw new ApiError(
      code ?? `Request failed with status ${response.status}.`,
      response.status,
      code,
    );
  }

  try {
    const body: unknown = await response.json();
    return options.decode === undefined ? (body as T) : options.decode(body);
  } catch {
    throw new ApiError(
      "The server returned data in an unexpected format.",
      response.status,
      "invalid_response",
    );
  }
}

export function encodePathPart(value: string): string {
  return encodeURIComponent(value);
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
