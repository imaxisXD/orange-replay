import { manifestKey, sessionPrefix } from "@orange-replay/shared";

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
  before?: SessionCursor;
  country?: string;
  browser?: string;
  hasErrors: boolean;
  minDurationMs?: number;
}

export type SessionQueryValue = string | number;

export interface SessionCursor {
  startedAt: number;
  sessionId?: string;
}

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

export function parseRecordingObjectKey(value: string): { ok: true; key: string } | { ok: false } {
  const match = /^p\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return { ok: false };
  }

  const projectId = match[1];
  const sessionId = match[2];
  const name = match[3];
  if (!isValidPathId(projectId) || !isValidPathId(sessionId)) {
    return { ok: false };
  }

  if (name === "manifest.json") {
    return { ok: true, key: manifestKey(projectId, sessionId) };
  }

  if (!isValidSegmentName(name)) {
    return { ok: false };
  }

  return { ok: true, key: `${sessionPrefix(projectId, sessionId)}/${name}` };
}

export function parseSessionListQuery(params: URLSearchParams): ParsedSessionListQuery {
  const parsedLimit = parsePositiveInteger(params.get("limit"), "limit");
  if (!parsedLimit.ok) return parsedLimit;

  const parsedBefore = parseOptionalCursor(params.get("before"));
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
  const whereClauses = [
    "project_id = ?",
    "NOT EXISTS (SELECT 1 FROM session_deletions d WHERE d.project_id = sessions.project_id AND d.session_id = sessions.session_id)",
  ];
  const bindings: SessionQueryValue[] = [projectId];

  if (options.before !== undefined) {
    if (options.before.sessionId === undefined) {
      whereClauses.push("started_at < ?");
      bindings.push(options.before.startedAt);
    } else {
      whereClauses.push("(started_at < ? OR (started_at = ? AND session_id < ?))");
      bindings.push(options.before.startedAt, options.before.startedAt, options.before.sessionId);
    }
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
    sql: `SELECT ${sessionRowColumns.join(", ")} FROM sessions INDEXED BY idx_sessions_project_time WHERE ${whereClauses.join(" AND ")} ORDER BY started_at DESC, session_id DESC LIMIT ?`,
    bindings,
  };
}

export function encodeSessionCursor(
  session: Pick<SessionRow, "started_at" | "session_id">,
): string {
  return `${session.started_at}:${session.session_id}`;
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

function parseOptionalCursor(
  value: string | null,
): { ok: true; value?: SessionCursor } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true };

  if (/^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, error: "invalid_before" };
    }
    return { ok: true, value: { startedAt: parsed } };
  }

  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    return { ok: false, error: "invalid_before" };
  }

  const startedAt = Number(value.slice(0, separator));
  const sessionId = value.slice(separator + 1);
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || !isValidPathId(sessionId)) {
    return { ok: false, error: "invalid_before" };
  }

  return { ok: true, value: { startedAt, sessionId } };
}
