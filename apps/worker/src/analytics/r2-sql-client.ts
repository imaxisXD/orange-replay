export const DEFAULT_R2_SQL_TIMEOUT_MS = 15_000;

export interface R2SqlSettings {
  accountId: string;
  bucketName: string;
  token: string;
  timeoutMs?: number;
  /** Test-only override. Production should use the Cloudflare default. */
  serviceUrl?: string;
}

export interface R2SqlMetrics {
  bytesScanned: number;
  filesScanned: number;
}

export interface R2SqlRows<Row extends Record<string, unknown>> {
  rows: Row[];
  metrics: R2SqlMetrics;
}

export type AnalyticsReadErrorKind =
  | "analytics_not_configured"
  | "analytics_request_timed_out"
  | "analytics_login_failed"
  | "analytics_access_denied"
  | "analytics_busy"
  | "analytics_service_unavailable"
  | "analytics_query_timed_out"
  | "analytics_query_failed"
  | "analytics_response_invalid"
  | "analytics_project_mismatch";

export class AnalyticsReadError extends Error {
  readonly kind: AnalyticsReadErrorKind;
  readonly canRetry: boolean;
  readonly upstreamStatus?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: AnalyticsReadErrorKind,
    message: string,
    options: {
      canRetry: boolean;
      upstreamStatus?: number;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "AnalyticsReadError";
    this.kind = kind;
    this.canRetry = options.canRetry;
    this.upstreamStatus = options.upstreamStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

type AnalyticsFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function runR2SqlProjectQuery<Row extends Record<string, unknown>>(
  settings: R2SqlSettings,
  projectId: string,
  query: string,
  fetchRequest: AnalyticsFetch = fetch,
): Promise<R2SqlRows<Row>> {
  const safeSettings = checkSettings(settings);
  if (projectId.length === 0) {
    throw new AnalyticsReadError("analytics_not_configured", "Analytics project is missing.", {
      canRetry: false,
    });
  }
  if (query.trim().length === 0) {
    throw new AnalyticsReadError("analytics_query_failed", "Analytics query is empty.", {
      canRetry: false,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safeSettings.timeoutMs);

  let response: Response;
  let body: unknown;
  try {
    response = await fetchRequest(makeQueryUrl(safeSettings), {
      method: "POST",
      headers: {
        authorization: `Bearer ${safeSettings.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    body = await readJsonBody(response);
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new AnalyticsReadError(
        "analytics_request_timed_out",
        "Analytics took too long to answer.",
        { canRetry: true, cause: error },
      );
    }

    throw new AnalyticsReadError(
      "analytics_service_unavailable",
      "Analytics could not be reached.",
      { canRetry: true, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw statusError(response, body);
  }

  const errorCodes = findErrorCodes(body);
  if (errorCodes.has(80_001)) {
    throw new AnalyticsReadError("analytics_query_timed_out", "Analytics query took too long.", {
      canRetry: true,
      upstreamStatus: response.status,
    });
  }

  if (!isRecord(body) || body.success !== true || !isRecord(body.result)) {
    if (errorCodes.size > 0 || (isRecord(body) && hasErrors(body))) {
      throw new AnalyticsReadError("analytics_query_failed", "Analytics query failed.", {
        canRetry: false,
        upstreamStatus: response.status,
      });
    }

    throw invalidResponse(response.status);
  }

  const rows = body.result.rows;
  const schema = body.result.schema;
  const metrics = body.result.metrics;
  if (!Array.isArray(rows) || !Array.isArray(schema) || !isRecord(metrics)) {
    throw invalidResponse(response.status);
  }

  const bytesScanned = readMetric(metrics, "bytes_scanned");
  const filesScanned = readMetric(metrics, "files_scanned");
  if (bytesScanned === null || filesScanned === null) {
    throw invalidResponse(response.status);
  }

  const checkedRows: Row[] = [];
  for (const row of rows) {
    if (!isRecord(row)) {
      throw invalidResponse(response.status);
    }
    if (row.project_id !== projectId) {
      throw new AnalyticsReadError(
        "analytics_project_mismatch",
        "Analytics returned data for the wrong project.",
        { canRetry: false, upstreamStatus: response.status },
      );
    }
    checkedRows.push(row as Row);
  }

  return {
    rows: checkedRows,
    metrics: { bytesScanned, filesScanned },
  };
}

function checkSettings(settings: R2SqlSettings): Required<R2SqlSettings> {
  const accountId = settings.accountId.trim();
  const bucketName = settings.bucketName.trim();
  const token = settings.token.trim();
  if (accountId.length === 0 || bucketName.length === 0 || token.length === 0) {
    throw new AnalyticsReadError("analytics_not_configured", "Analytics is not configured.", {
      canRetry: false,
    });
  }

  const timeoutMs = settings.timeoutMs ?? DEFAULT_R2_SQL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new AnalyticsReadError("analytics_not_configured", "Analytics timeout is not valid.", {
      canRetry: false,
    });
  }

  return {
    accountId,
    bucketName,
    token,
    timeoutMs,
    serviceUrl: (settings.serviceUrl ?? "https://api.sql.cloudflarestorage.com").replace(
      /\/+$/,
      "",
    ),
  };
}

function makeQueryUrl(settings: Required<R2SqlSettings>): string {
  return `${settings.serviceUrl}/api/v1/accounts/${encodeURIComponent(settings.accountId)}/r2-sql/query/${encodeURIComponent(settings.bucketName)}`;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

function statusError(response: Response, body: unknown): AnalyticsReadError {
  const shared = {
    upstreamStatus: response.status,
    retryAfterSeconds: readRetryAfter(response.headers.get("retry-after")),
  };

  if (response.status === 401) {
    return new AnalyticsReadError("analytics_login_failed", "Analytics login failed.", {
      ...shared,
      canRetry: false,
    });
  }
  if (response.status === 403) {
    return new AnalyticsReadError("analytics_access_denied", "Analytics access was denied.", {
      ...shared,
      canRetry: false,
    });
  }
  if (response.status === 429) {
    return new AnalyticsReadError("analytics_busy", "Analytics is busy. Try again soon.", {
      ...shared,
      canRetry: true,
    });
  }
  if (findErrorCodes(body).has(80_001)) {
    return new AnalyticsReadError("analytics_query_timed_out", "Analytics query took too long.", {
      ...shared,
      canRetry: true,
    });
  }
  if (response.status >= 500) {
    return new AnalyticsReadError(
      "analytics_service_unavailable",
      "Analytics is temporarily unavailable.",
      { ...shared, canRetry: true },
    );
  }
  return new AnalyticsReadError("analytics_query_failed", "Analytics query failed.", {
    ...shared,
    canRetry: false,
  });
}

function invalidResponse(upstreamStatus: number): AnalyticsReadError {
  return new AnalyticsReadError(
    "analytics_response_invalid",
    "Analytics returned an invalid answer.",
    { canRetry: true, upstreamStatus },
  );
}

function readMetric(metrics: Record<string, unknown>, name: string): number | null {
  const value = metrics[name];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function findErrorCodes(value: unknown): Set<number> {
  const codes = new Set<number>();
  visit(value, 0, codes);
  return codes;
}

function visit(value: unknown, depth: number, codes: Set<number>): void {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, depth + 1, codes);
    return;
  }
  if (!isRecord(value)) return;

  const code = value.code;
  if (typeof code === "number" && Number.isSafeInteger(code)) codes.add(code);
  if (typeof code === "string" && /^[0-9]+$/.test(code)) codes.add(Number(code));
  for (const child of Object.values(value)) visit(child, depth + 1, codes);
}

function hasErrors(value: Record<string, unknown>): boolean {
  return Array.isArray(value.errors) && value.errors.length > 0;
}

function readRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^[0-9]+$/.test(value)) return Number(value);

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
