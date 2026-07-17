import {
  manifestKey,
  parseSessionFilterQuery,
  sessionPrefix,
  type SessionFilter,
  type SessionListItem,
} from "@orange-replay/shared";
import {
  buildFinalizedSessionCursorSql,
  buildFinalizedSessionFilterSql,
  buildFinalizedSessionSnapshotSql,
  finalizedSessionOrderSql,
  parseOptionalSessionCursor,
  sessionSortValues,
  type FinalizedSessionSqlDialect,
  type SessionCursor,
  type SessionListOptions,
  type SessionSort,
} from "./finalized-session-semantics.ts";

export {
  encodeSessionCursor,
  sessionSortValues,
  UNKNOWN_ERROR_DETAIL,
} from "./finalized-session-semantics.ts";
export type {
  SessionCursor,
  SessionListOptions,
  SessionSort,
} from "./finalized-session-semantics.ts";

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
  "page_count",
  "analytics_version",
  "max_scroll_depth",
  "quick_backs",
  "interaction_time_ms",
  "activity_hist",
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

// Columns that exist only in D1, not in the analytics warehouse tables.
// Warehouse SQL keeps `sessionRowColumns`; D1 list/head reads select these too.
export const d1SessionRowColumns = [...sessionRowColumns, "has_checkpoint"] as const;

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
  page_count: number | null;
  analytics_version: number;
  max_scroll_depth: number | null;
  quick_backs: number | null;
  interaction_time_ms: number | null;
  activity_hist: string | null;
  clicks: number;
  errors: number;
  rages: number;
  navs: number;
  bytes: number;
  segment_count: number;
  flags: number;
  manifest_key: string;
  expires_at: number;
  /** 1/0 playability fact; NULL on rows indexed before migration 0020. */
  has_checkpoint: number | null;
}

/** Maps a private D1 query row to the stable dashboard wire model. */
export function sessionRowToListItem(row: SessionRow): SessionListItem {
  return {
    session_id: row.session_id,
    project_id: row.project_id,
    org_id: row.org_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_ms: row.duration_ms,
    country: row.country,
    region: row.region,
    city: row.city,
    device: row.device,
    browser: row.browser,
    os: row.os,
    entry_url: row.entry_url,
    url_count: row.url_count,
    page_count: row.page_count,
    analytics_version: row.analytics_version,
    max_scroll_depth: row.max_scroll_depth,
    quick_backs: row.quick_backs,
    interaction_time_ms: row.interaction_time_ms,
    activity_hist: row.activity_hist,
    clicks: row.clicks,
    errors: row.errors,
    rages: row.rages,
    navs: row.navs,
    bytes: row.bytes,
    segment_count: row.segment_count,
    flags: row.flags,
    manifest_key: row.manifest_key,
    expires_at: row.expires_at,
    has_checkpoint: row.has_checkpoint === null ? null : row.has_checkpoint !== 0,
  };
}

export type SessionQueryValue = string | number;

export interface SessionsQuery {
  sql: string;
  bindings: SessionQueryValue[];
}

export interface SessionWhere {
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

  const parsedSort = parseSessionSort(params);
  if (!parsedSort.ok) return parsedSort;

  const parsedBefore = parseOptionalSessionCursor(
    params.get("before"),
    parsedSort.value,
    isValidPathId,
  );
  if (!parsedBefore.ok) return parsedBefore;

  const parsedFilter = parseSessionFilterQuery(params);
  if (!parsedFilter.ok) return parsedFilter;

  return {
    ok: true,
    options: {
      limit: Math.min(parsedLimit.value ?? 50, 100),
      sort: parsedSort.value,
      before: parsedBefore.value,
      ...parsedFilter.filter,
    },
  };
}

export function buildSessionsQuery(projectId: string, options: SessionListOptions): SessionsQuery {
  const where = buildSessionWhere(projectId, options, options.before);
  const orderBy = finalizedSessionOrderSql(options.sort, d1SessionDialect("sessions", []));

  return {
    sql: `SELECT ${d1SessionRowColumns.join(", ")} FROM sessions WHERE ${where.sql} ORDER BY ${orderBy} LIMIT ?`,
    bindings: [...where.bindings, options.limit],
  };
}

export function buildSessionWhere(
  projectId: string,
  filter: SessionFilter,
  before?: SessionCursor,
  tableAlias: "sessions" | "s" = "sessions",
): SessionWhere {
  const column = (name: string): string =>
    tableAlias === "sessions" ? name : `${tableAlias}.${name}`;
  const whereClauses = [
    `${column("project_id")} = ?`,
    `NOT EXISTS (SELECT 1 FROM session_deletions d WHERE d.project_id = ${tableAlias}.project_id AND d.session_id = ${tableAlias}.session_id)`,
  ];
  const bindings: SessionQueryValue[] = [projectId];
  const dialect = d1SessionDialect(tableAlias, bindings);

  whereClauses.push(...buildFinalizedSessionSnapshotSql(filter, dialect));

  if (before !== undefined) {
    const cursorSql = buildFinalizedSessionCursorSql(before.sort, before, dialect);
    if (cursorSql !== undefined) whereClauses.push(cursorSql);
  }

  whereClauses.push(...buildFinalizedSessionFilterSql(filter, dialect));

  return {
    sql: whereClauses.join(" AND "),
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

function parseSessionSort(
  params: URLSearchParams,
): { ok: true; value: SessionSort } | { ok: false; error: string } {
  const values = params.getAll("sort");
  if (values.length === 0) return { ok: true, value: "newest" };

  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !sessionSortValues.includes(value as SessionSort)
  ) {
    return { ok: false, error: "invalid_sort" };
  }

  return { ok: true, value: value as SessionSort };
}

function d1SessionDialect(
  tableAlias: "sessions" | "s",
  bindings: SessionQueryValue[],
): FinalizedSessionSqlDialect {
  const column = (name: Parameters<FinalizedSessionSqlDialect["column"]>[0]): string =>
    tableAlias === "sessions" ? name : `${tableAlias}.${name}`;

  return {
    column,
    wholeNumber(value) {
      bindings.push(value);
      return "?";
    },
    text(value) {
      bindings.push(value);
      return "?";
    },
    entryUrlPrefix(prefix) {
      const upperBound = prefixUpperBound(prefix);
      if (upperBound === null) {
        bindings.push(prefix, prefix, prefix);
        return `${column("entry_url")} >= ? AND substr(${column("entry_url")}, 1, length(?)) = ?`;
      }
      bindings.push(prefix, upperBound);
      return `${column("entry_url")} >= ? AND ${column("entry_url")} < ?`;
    },
    errorDetail(detail, unknownDetail, eventKind) {
      bindings.push(eventKind, unknownDetail, detail);
      return `EXISTS (SELECT 1 FROM session_events e WHERE e.project_id = ${tableAlias}.project_id AND e.session_id = ${tableAlias}.session_id AND e.kind = ? AND COALESCE(e.detail, ?) = ?)`;
    },
    warehouseVersion(version, recordKind) {
      bindings.push(recordKind, version, recordKind, version);
      return `(EXISTS (SELECT 1 FROM analytics_export_outbox a WHERE a.project_id = ${tableAlias}.project_id AND a.session_id = ${tableAlias}.session_id AND a.record_kind = ? AND a.export_sequence <= ?)
        OR EXISTS (SELECT 1 FROM analytics_export_ledger l WHERE l.project_id = ${tableAlias}.project_id AND l.session_id = ${tableAlias}.session_id AND l.record_kind = ? AND l.export_sequence <= ?))`;
    },
  };
}

function prefixUpperBound(prefix: string): string | null {
  const codePoints = Array.from(prefix, (character) => character.codePointAt(0) ?? 0);

  for (let index = codePoints.length - 1; index >= 0; index -= 1) {
    const codePoint = codePoints[index];
    if (codePoint !== undefined && codePoint < 0x10ffff) {
      const nextCodePoint = codePoint + 1;
      return String.fromCodePoint(
        ...codePoints.slice(0, index),
        nextCodePoint >= 0xd800 && nextCodePoint <= 0xdfff ? 0xe000 : nextCodePoint,
      );
    }
  }

  return null;
}
