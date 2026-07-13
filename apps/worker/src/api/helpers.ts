import {
  manifestKey,
  parseSessionFilterQuery,
  sessionPrefix,
  type SessionFilter,
} from "@orange-replay/shared";

export const pathIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const segmentNamePattern = /^seg-\d{6}\.ors$/;
export const UNKNOWN_ERROR_DETAIL = "Unknown error";

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

export type SessionColumn = (typeof sessionRowColumns)[number];

export const sessionSortValues = ["newest", "friction", "duration", "clicks", "pages"] as const;
export type SessionSort = (typeof sessionSortValues)[number];

const frictionScoreSql = (tableAlias: "sessions" | "s" = "sessions"): string => {
  const prefix = tableAlias === "sessions" ? "" : `${tableAlias}.`;
  // Errors are the strongest sign of a broken journey, then rage clicks,
  // then ordinary click activity as the final tie-break signal.
  return `(${prefix}errors * 1000 + ${prefix}rages * 100 + ${prefix}clicks)`;
};

const sessionSortSql = {
  newest: {
    column: "started_at",
    orderBy: "started_at DESC, session_id DESC",
  },
  friction: {
    column: null,
    orderBy: `${frictionScoreSql()} DESC, session_id DESC`,
  },
  duration: {
    column: "duration_ms",
    orderBy: "duration_ms DESC, session_id DESC",
  },
  clicks: {
    column: "clicks",
    orderBy: "clicks DESC, session_id DESC",
  },
  pages: {
    column: "page_count",
    orderBy: "page_count IS NULL, page_count DESC, session_id DESC",
  },
} as const satisfies Record<SessionSort, { column: SessionColumn | null; orderBy: string }>;

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
}

export type SessionListOptions = SessionFilter & {
  limit: number;
  sort: SessionSort;
  before?: SessionCursor;
};

export type SessionQueryValue = string | number;

export type SessionCursor =
  | { sort: "newest"; sortValue: number; sessionId?: string }
  | { sort: "friction" | "duration" | "clicks"; sortValue: number; sessionId: string }
  | { sort: "pages"; sortValue: number | null; sessionId: string };

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

  const parsedBefore = parseOptionalCursor(params.get("before"), parsedSort.value);
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
  const sort = sessionSortSql[options.sort];

  return {
    sql: `SELECT ${sessionRowColumns.join(", ")} FROM sessions WHERE ${where.sql} ORDER BY ${sort.orderBy} LIMIT ?`,
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

  if (filter.warehouse_version !== undefined) {
    whereClauses.push(
      `(EXISTS (SELECT 1 FROM analytics_export_outbox a WHERE a.project_id = ${tableAlias}.project_id AND a.session_id = ${tableAlias}.session_id AND a.record_kind = ? AND a.export_sequence <= ?)
        OR EXISTS (SELECT 1 FROM analytics_export_ledger l WHERE l.project_id = ${tableAlias}.project_id AND l.session_id = ${tableAlias}.session_id AND l.record_kind = ? AND l.export_sequence <= ?))`,
    );
    bindings.push("session", filter.warehouse_version, "session", filter.warehouse_version);
  }

  if (before !== undefined) {
    const sortConfig = sessionSortSql[before.sort];
    const sortColumn =
      before.sort === "friction"
        ? frictionScoreSql(tableAlias)
        : column(sortConfig.column as SessionColumn);

    if (before.sort === "newest") {
      if (before.sessionId === undefined) {
        whereClauses.push(`${sortColumn} < ?`);
        bindings.push(before.sortValue);
      } else {
        whereClauses.push(
          `(${sortColumn} < ? OR (${sortColumn} = ? AND ${column("session_id")} < ?))`,
        );
        bindings.push(before.sortValue, before.sortValue, before.sessionId);
      }
    } else if (before.sort === "pages") {
      if (before.sortValue === null) {
        whereClauses.push(`(${sortColumn} IS NULL AND ${column("session_id")} < ?)`);
        bindings.push(before.sessionId);
      } else {
        whereClauses.push(
          `(${sortColumn} IS NULL OR ${sortColumn} < ? OR (${sortColumn} = ? AND ${column("session_id")} < ?))`,
        );
        bindings.push(before.sortValue, before.sortValue, before.sessionId);
      }
    } else {
      whereClauses.push(
        `(${sortColumn} < ? OR (${sortColumn} = ? AND ${column("session_id")} < ?))`,
      );
      bindings.push(before.sortValue, before.sortValue, before.sessionId);
    }
  }

  if (filter.from !== undefined) {
    whereClauses.push(`${column("started_at")} >= ?`);
    bindings.push(filter.from);
  }

  if (filter.to !== undefined) {
    whereClauses.push(`${column("started_at")} <= ?`);
    bindings.push(filter.to);
  }

  if (filter.country !== undefined) {
    whereClauses.push(`${column("country")} = ?`);
    bindings.push(filter.country);
  }

  if (filter.region !== undefined) {
    whereClauses.push(`${column("region")} = ?`);
    bindings.push(filter.region);
  }

  if (filter.device !== undefined) {
    whereClauses.push(`${column("device")} = ?`);
    bindings.push(filter.device);
  }

  if (filter.browser !== undefined) {
    whereClauses.push(`${column("browser")} = ?`);
    bindings.push(filter.browser);
  }

  if (filter.os !== undefined) {
    whereClauses.push(`${column("os")} = ?`);
    bindings.push(filter.os);
  }

  if (filter.entry_url !== undefined) {
    whereClauses.push(`${column("entry_url")} = ?`);
    bindings.push(filter.entry_url);
  }

  if (filter.entry_url_prefix !== undefined) {
    const upperBound = prefixUpperBound(filter.entry_url_prefix);
    if (upperBound === null) {
      whereClauses.push(
        `${column("entry_url")} >= ? AND substr(${column("entry_url")}, 1, length(?)) = ?`,
      );
      bindings.push(filter.entry_url_prefix, filter.entry_url_prefix, filter.entry_url_prefix);
    } else {
      whereClauses.push(`${column("entry_url")} >= ? AND ${column("entry_url")} < ?`);
      bindings.push(filter.entry_url_prefix, upperBound);
    }
  }

  if (filter.has_errors !== undefined) {
    whereClauses.push(filter.has_errors ? `${column("errors")} >= ?` : `${column("errors")} = ?`);
    bindings.push(filter.has_errors ? 1 : 0);
  }

  if (filter.error_detail !== undefined) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM session_events e WHERE e.project_id = ${tableAlias}.project_id AND e.session_id = ${tableAlias}.session_id AND e.kind = ? AND COALESCE(e.detail, ?) = ?)`,
    );
    bindings.push("error", UNKNOWN_ERROR_DETAIL, filter.error_detail);
  }

  if (filter.has_page_coverage !== undefined) {
    whereClauses.push(
      filter.has_page_coverage
        ? `(${column("analytics_version")} >= ? AND ${column("page_count")} IS NOT NULL)`
        : `(${column("analytics_version")} < ? OR ${column("page_count")} IS NULL)`,
    );
    bindings.push(1);
  }

  if (filter.has_rage !== undefined) {
    whereClauses.push(`${column("analytics_version")} >= ?`);
    bindings.push(2);
    whereClauses.push(filter.has_rage ? `${column("rages")} >= ?` : `${column("rages")} = ?`);
    bindings.push(filter.has_rage ? 1 : 0);
  }

  if (filter.has_quick_back !== undefined) {
    whereClauses.push(`${column("analytics_version")} >= ?`);
    bindings.push(2);
    whereClauses.push(
      filter.has_quick_back ? `${column("quick_backs")} >= ?` : `${column("quick_backs")} = ?`,
    );
    bindings.push(filter.has_quick_back ? 1 : 0);
  }

  if (filter.has_insights !== undefined) {
    whereClauses.push(
      filter.has_insights
        ? `${column("analytics_version")} >= ?`
        : `${column("analytics_version")} < ?`,
    );
    bindings.push(2);
  }

  if (filter.min_duration_ms !== undefined) {
    whereClauses.push(`${column("duration_ms")} >= ?`);
    bindings.push(filter.min_duration_ms);
  }

  return {
    sql: whereClauses.join(" AND "),
    bindings,
  };
}

export function encodeSessionCursor(
  session: Pick<SessionRow, "session_id"> &
    Partial<
      Pick<SessionRow, "started_at" | "duration_ms" | "clicks" | "errors" | "rages" | "page_count">
    >,
  sort: SessionSort = "newest",
): string {
  if (sort === "pages") {
    if (session.page_count === undefined) {
      throw new Error("Missing page count for the pages cursor");
    }
    return `pages:${session.page_count === null ? "null" : session.page_count}:${session.session_id}`;
  }

  if (sort === "friction") {
    if (
      typeof session.errors !== "number" ||
      typeof session.rages !== "number" ||
      typeof session.clicks !== "number"
    ) {
      throw new Error("Missing friction values for the sessions cursor");
    }
    const score = session.errors * 1000 + session.rages * 100 + session.clicks;
    return `friction:${score}:${session.session_id}`;
  }

  const sortColumn = sessionSortSql[sort].column;
  const sortValue = sortColumn === null ? undefined : session[sortColumn];
  if (typeof sortValue !== "number") {
    throw new Error(`Missing ${sort} value for the sessions cursor`);
  }

  return sort === "newest"
    ? `${sortValue}:${session.session_id}`
    : `${sort}:${sortValue}:${session.session_id}`;
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

function parseOptionalCursor(
  value: string | null,
  sort: SessionSort,
): { ok: true; value?: SessionCursor } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true };

  if (sort === "newest" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, error: "invalid_before" };
    }
    return { ok: true, value: { sort: "newest", sortValue: parsed } };
  }

  if (sort === "newest") {
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1) {
      return { ok: false, error: "invalid_before" };
    }

    const sortValue = parseCursorNumber(value.slice(0, separator));
    const sessionId = value.slice(separator + 1);
    if (sortValue === null || !isValidPathId(sessionId)) {
      return { ok: false, error: "invalid_before" };
    }

    return { ok: true, value: { sort: "newest", sortValue, sessionId } };
  }

  const firstSeparator = value.indexOf(":");
  const secondSeparator = value.indexOf(":", firstSeparator + 1);
  if (
    firstSeparator < 1 ||
    secondSeparator === -1 ||
    secondSeparator === value.length - 1 ||
    value.indexOf(":", secondSeparator + 1) !== -1
  ) {
    return { ok: false, error: "invalid_before" };
  }

  const cursorSort = value.slice(0, firstSeparator);
  const rawSortValue = value.slice(firstSeparator + 1, secondSeparator);
  const sessionId = value.slice(secondSeparator + 1);
  if (cursorSort !== sort || !isValidPathId(sessionId)) {
    return { ok: false, error: "invalid_before" };
  }

  if (sort === "pages" && rawSortValue === "null") {
    return { ok: true, value: { sort, sortValue: null, sessionId } };
  }

  const sortValue = parseCursorNumber(rawSortValue);
  if (sortValue === null) {
    return { ok: false, error: "invalid_before" };
  }

  if (sort === "pages") {
    return { ok: true, value: { sort, sortValue, sessionId } };
  }

  return { ok: true, value: { sort, sortValue, sessionId } };
}

function parseCursorNumber(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
