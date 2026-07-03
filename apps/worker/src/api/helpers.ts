export const pathIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const segmentNamePattern = /^seg-\d{6}\.ors$/;

export const sessionRowColumns = [
  "session_id",
  "project_id",
  "org_id",
  "started_at",
  "ended_at",
  "duration_ms",
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
  "entry_url",
  "url_count",
  "clicks",
  "errors",
  "rages",
  "navs",
  "bytes",
  "segment_count",
  "flags",
  "manifest_key",
  "expires_at",
] as const;

export type SessionColumn = (typeof sessionRowColumns)[number];

export interface SessionRow {
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

export interface SessionListOptions {
  limit: number;
  before?: number;
  country?: string;
  browser?: string;
  hasErrors: boolean;
  minDurationMs?: number;
}

export type SessionQueryValue = string | number;

export interface SessionsQuery {
  sql: string;
  bindings: SessionQueryValue[];
}

export type ParsedSessionListQuery =
  | { ok: true; options: SessionListOptions }
  | { ok: false; error: string };

export function isValidPathId(value: string): boolean {
  return pathIdPattern.test(value);
}

export function isValidSegmentName(value: string): boolean {
  return segmentNamePattern.test(value);
}

export function parseSessionListQuery(params: URLSearchParams): ParsedSessionListQuery {
  const parsedLimit = parsePositiveInteger(params.get("limit"), "limit");
  if (!parsedLimit.ok) return parsedLimit;

  const parsedBefore = parseOptionalInteger(params.get("before"), "before", 0);
  if (!parsedBefore.ok) return parsedBefore;

  const parsedMinDuration = parseOptionalInteger(
    params.get("min_duration_ms"),
    "min_duration_ms",
    0,
  );
  if (!parsedMinDuration.ok) return parsedMinDuration;

  const country = params.get("country");
  const browser = params.get("browser");

  return {
    ok: true,
    options: {
      limit: Math.min(parsedLimit.value ?? 50, 100),
      before: parsedBefore.value,
      country: country && country.length > 0 ? country : undefined,
      browser: browser && browser.length > 0 ? browser : undefined,
      hasErrors: params.get("has_errors") === "1",
      minDurationMs: parsedMinDuration.value,
    },
  };
}

export function buildSessionsQuery(projectId: string, options: SessionListOptions): SessionsQuery {
  const whereClauses = ["project_id = ?"];
  const bindings: SessionQueryValue[] = [projectId];

  if (options.before !== undefined) {
    whereClauses.push("started_at < ?");
    bindings.push(options.before);
  }

  if (options.country !== undefined) {
    whereClauses.push("country = ?");
    bindings.push(options.country);
  }

  if (options.browser !== undefined) {
    whereClauses.push("browser = ?");
    bindings.push(options.browser);
  }

  if (options.hasErrors) {
    whereClauses.push("errors > 0");
  }

  if (options.minDurationMs !== undefined) {
    whereClauses.push("duration_ms >= ?");
    bindings.push(options.minDurationMs);
  }

  bindings.push(options.limit);

  return {
    sql: `SELECT ${sessionRowColumns.join(", ")} FROM sessions INDEXED BY idx_sessions_project_time WHERE ${whereClauses.join(" AND ")} ORDER BY started_at DESC LIMIT ?`,
    bindings,
  };
}

export function outcomeForStatus(status: number): "success" | "client_error" | "server_error" {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "success";
}

function parsePositiveInteger(
  value: string | null,
  name: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { ok: false, error: `invalid_${name}` };
  }
  return { ok: true, value: parsed };
}

function parseOptionalInteger(
  value: string | null,
  name: string,
  minimum: number,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    return { ok: false, error: `invalid_${name}` };
  }
  return { ok: true, value: parsed };
}
