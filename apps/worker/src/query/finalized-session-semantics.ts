import type { SessionFilter } from "@orange-replay/shared";

export const UNKNOWN_ERROR_DETAIL = "Unknown error";
const ERROR_EVENT_KIND = "error";
const SESSION_EXPORT_KIND = "session";

export const sessionSortValues = ["newest", "friction", "duration", "clicks", "pages"] as const;
export type SessionSort = (typeof sessionSortValues)[number];

export type SessionCursor =
  | { sort: "newest"; sortValue: number; sessionId?: string }
  | { sort: "friction" | "duration" | "clicks"; sortValue: number; sessionId: string }
  | { sort: "pages"; sortValue: number | null; sessionId: string };

export type SessionListOptions = SessionFilter & {
  limit: number;
  sort: SessionSort;
  before?: SessionCursor;
};

export type FinalizedSessionColumn =
  | "analytics_version"
  | "browser"
  | "city"
  | "clicks"
  | "country"
  | "device"
  | "duration_ms"
  | "entry_url"
  | "errors"
  | "os"
  | "page_count"
  | "quick_backs"
  | "rages"
  | "region"
  | "session_id"
  | "started_at";

/**
 * The two stores keep deliberately different SQL mechanics. This small port
 * renders only the places where those mechanics differ; the session-set
 * meaning stays in this module.
 */
export interface FinalizedSessionSqlDialect {
  column(name: FinalizedSessionColumn): string;
  wholeNumber(value: number, label: string): string;
  text(value: string): string;
  entryUrlPrefix(prefix: string): string;
  errorDetail(detail: string, unknownDetail: string, eventKind: string): string;
  warehouseVersion(version: number, recordKind: string): string | undefined;
}

const finalizedSessionFilterKeys = [
  "warehouse_version",
  "from",
  "to",
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
  "entry_url",
  "entry_url_prefix",
  "has_errors",
  "error_detail",
  "has_page_coverage",
  "has_rage",
  "has_quick_back",
  "has_insights",
  "min_duration_ms",
] as const satisfies readonly (keyof SessionFilter)[];

// A new SessionFilter key must be given meaning here before TypeScript passes.
const allSessionFilterKeysAreHandled: Exclude<
  keyof SessionFilter,
  (typeof finalizedSessionFilterKeys)[number]
> extends never
  ? true
  : never = true;
void allSessionFilterKeysAreHandled;

export function buildFinalizedSessionSnapshotSql(
  filter: SessionFilter,
  dialect: FinalizedSessionSqlDialect,
): string[] {
  if (filter.warehouse_version === undefined) return [];
  const clause = dialect.warehouseVersion(filter.warehouse_version, SESSION_EXPORT_KIND);
  return clause === undefined ? [] : [clause];
}

export function buildFinalizedSessionFilterSql(
  filter: SessionFilter,
  dialect: FinalizedSessionSqlDialect,
): string[] {
  const clauses: string[] = [];

  if (filter.from !== undefined) {
    clauses.push(
      `${dialect.column("started_at")} >= ${dialect.wholeNumber(filter.from, "Start time")}`,
    );
  }
  if (filter.to !== undefined) {
    clauses.push(
      `${dialect.column("started_at")} <= ${dialect.wholeNumber(filter.to, "End time")}`,
    );
  }
  addTextFilter(clauses, dialect, "country", filter.country);
  addTextFilter(clauses, dialect, "region", filter.region);
  addTextFilter(clauses, dialect, "city", filter.city);
  addTextFilter(clauses, dialect, "device", filter.device);
  addTextFilter(clauses, dialect, "browser", filter.browser);
  addTextFilter(clauses, dialect, "os", filter.os);
  addTextFilter(clauses, dialect, "entry_url", filter.entry_url);

  if (filter.entry_url_prefix !== undefined) {
    clauses.push(dialect.entryUrlPrefix(filter.entry_url_prefix));
  }
  if (filter.has_errors !== undefined) {
    const comparison = filter.has_errors ? ">=" : "=";
    const value = dialect.wholeNumber(filter.has_errors ? 1 : 0, "Error filter");
    clauses.push(`${dialect.column("errors")} ${comparison} ${value}`);
  }
  if (filter.error_detail !== undefined) {
    clauses.push(dialect.errorDetail(filter.error_detail, UNKNOWN_ERROR_DETAIL, ERROR_EVENT_KIND));
  }
  if (filter.has_page_coverage !== undefined) {
    const version = dialect.wholeNumber(1, "Page coverage version");
    clauses.push(
      filter.has_page_coverage
        ? `(${dialect.column("analytics_version")} >= ${version} AND ${dialect.column("page_count")} IS NOT NULL)`
        : `(${dialect.column("analytics_version")} < ${version} OR ${dialect.column("page_count")} IS NULL)`,
    );
  }
  if (filter.has_rage !== undefined) {
    clauses.push(
      `${dialect.column("analytics_version")} >= ${dialect.wholeNumber(2, "Insight version")}`,
    );
    const comparison = filter.has_rage ? ">=" : "=";
    clauses.push(
      `${dialect.column("rages")} ${comparison} ${dialect.wholeNumber(filter.has_rage ? 1 : 0, "Rage filter")}`,
    );
  }
  if (filter.has_quick_back !== undefined) {
    clauses.push(
      `${dialect.column("analytics_version")} >= ${dialect.wholeNumber(2, "Insight version")}`,
    );
    const comparison = filter.has_quick_back ? ">=" : "=";
    clauses.push(
      `${dialect.column("quick_backs")} ${comparison} ${dialect.wholeNumber(filter.has_quick_back ? 1 : 0, "Quick-back filter")}`,
    );
  }
  if (filter.has_insights !== undefined) {
    const comparison = filter.has_insights ? ">=" : "<";
    clauses.push(
      `${dialect.column("analytics_version")} ${comparison} ${dialect.wholeNumber(2, "Insight version")}`,
    );
  }
  if (filter.min_duration_ms !== undefined) {
    clauses.push(
      `${dialect.column("duration_ms")} >= ${dialect.wholeNumber(filter.min_duration_ms, "Minimum duration")}`,
    );
  }

  return clauses;
}

export function finalizedSessionFilterNeedsErrorRows(filter: SessionFilter): boolean {
  return filter.error_detail !== undefined;
}

export function buildFinalizedSessionCursorSql(
  sortValue: string,
  before: SessionCursor | undefined,
  dialect: FinalizedSessionSqlDialect,
): string | undefined {
  const sort = checkedSessionSort(sortValue);
  if (before === undefined) return undefined;
  checkSessionCursorSort(before, sort);

  const sessionColumn = dialect.column("session_id");

  if (sort === "newest") {
    if (before.sort !== "newest" || typeof before.sortValue !== "number") {
      throw new Error("Newest cursor is not valid");
    }
    const column = dialect.column("started_at");
    const firstValue = dialect.wholeNumber(before.sortValue, "Newest cursor");
    if (before.sessionId === undefined) return `${column} < ${firstValue}`;
    const secondValue = dialect.wholeNumber(before.sortValue, "Newest cursor");
    const sessionId = dialect.text(before.sessionId);
    return `(${column} < ${firstValue} OR (${column} = ${secondValue} AND ${sessionColumn} < ${sessionId}))`;
  }
  if (before.sessionId === undefined) {
    throw new Error("Session cursor is missing its session id");
  }
  if (sort === "pages") {
    if (before.sort !== "pages") {
      throw new Error("Session cursor does not match its sort");
    }
    const column = dialect.column("page_count");
    if (before.sortValue === null) {
      const sessionId = dialect.text(before.sessionId);
      return `(${column} IS NULL AND ${sessionColumn} < ${sessionId})`;
    }
    const firstValue = dialect.wholeNumber(before.sortValue, "Pages cursor");
    const secondValue = dialect.wholeNumber(before.sortValue, "Pages cursor");
    const sessionId = dialect.text(before.sessionId);
    return `(${column} IS NULL OR ${column} < ${firstValue} OR (${column} = ${secondValue} AND ${sessionColumn} < ${sessionId}))`;
  }

  if (before.sort === "newest" || before.sort === "pages" || typeof before.sortValue !== "number") {
    throw new Error(`${sort} cursor is not valid`);
  }
  const expression = sessionSortExpression(sort, dialect);
  const firstValue = dialect.wholeNumber(before.sortValue, `${sort} cursor`);
  const secondValue = dialect.wholeNumber(before.sortValue, `${sort} cursor`);
  const sessionId = dialect.text(before.sessionId);
  return `(${expression} < ${firstValue} OR (${expression} = ${secondValue} AND ${sessionColumn} < ${sessionId}))`;
}

export function finalizedSessionOrderSql(
  sortValue: string,
  dialect: FinalizedSessionSqlDialect,
): string {
  const sort = checkedSessionSort(sortValue);
  const sessionId = dialect.column("session_id");
  if (sort === "pages") {
    const pages = dialect.column("page_count");
    return `${pages} IS NULL, ${pages} DESC, ${sessionId} DESC`;
  }
  return `${sessionSortExpression(sort, dialect)} DESC, ${sessionId} DESC`;
}

export function encodeSessionCursor(
  session: {
    session_id: string;
    started_at?: number;
    duration_ms?: number;
    clicks?: number;
    errors?: number;
    rages?: number;
    page_count?: number | null;
  },
  sortValue: SessionSort = "newest",
): string {
  const sort = checkedSessionSort(sortValue);
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
    return `friction:${frictionScore({ errors: session.errors, rages: session.rages, clicks: session.clicks })}:${session.session_id}`;
  }

  const sortValueFromSession =
    sort === "newest"
      ? session.started_at
      : sort === "duration"
        ? session.duration_ms
        : session.clicks;
  if (typeof sortValueFromSession !== "number") {
    throw new Error(`Missing ${sort} value for the sessions cursor`);
  }
  return sort === "newest"
    ? `${sortValueFromSession}:${session.session_id}`
    : `${sort}:${sortValueFromSession}:${session.session_id}`;
}

export function sessionCursorText(cursor: SessionCursor): string {
  if (cursor.sort === "newest") {
    return cursor.sessionId === undefined
      ? String(cursor.sortValue)
      : `${cursor.sortValue}:${cursor.sessionId}`;
  }
  const value = cursor.sortValue === null ? "null" : String(cursor.sortValue);
  return `${cursor.sort}:${value}:${cursor.sessionId}`;
}

export function parseOptionalSessionCursor(
  value: string | null,
  sort: SessionSort,
  isValidSessionId: (value: string) => boolean,
): { ok: true; value?: SessionCursor } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true };

  if (sort === "newest" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return { ok: false, error: "invalid_before" };
    return { ok: true, value: { sort: "newest", sortValue: parsed } };
  }

  if (sort === "newest") {
    const separator = value.indexOf(":");
    if (separator < 1 || separator === value.length - 1) {
      return { ok: false, error: "invalid_before" };
    }
    const cursorValue = parseCursorNumber(value.slice(0, separator));
    const sessionId = value.slice(separator + 1);
    if (cursorValue === null || !isValidSessionId(sessionId)) {
      return { ok: false, error: "invalid_before" };
    }
    return { ok: true, value: { sort: "newest", sortValue: cursorValue, sessionId } };
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
  const rawCursorValue = value.slice(firstSeparator + 1, secondSeparator);
  const sessionId = value.slice(secondSeparator + 1);
  if (cursorSort !== sort || !isValidSessionId(sessionId)) {
    return { ok: false, error: "invalid_before" };
  }
  if (sort === "pages" && rawCursorValue === "null") {
    return { ok: true, value: { sort, sortValue: null, sessionId } };
  }

  const cursorValue = parseCursorNumber(rawCursorValue);
  if (cursorValue === null) return { ok: false, error: "invalid_before" };
  if (sort === "pages") return { ok: true, value: { sort, sortValue: cursorValue, sessionId } };
  return { ok: true, value: { sort, sortValue: cursorValue, sessionId } };
}

export function checkedSessionSort(value: string): SessionSort {
  if (!sessionSortValues.includes(value as SessionSort)) {
    throw new Error("Unknown analytics session sort");
  }
  return value as SessionSort;
}

export function checkSessionCursorSort(before: SessionCursor | undefined, sort: SessionSort): void {
  if (before !== undefined && before.sort !== sort) {
    throw new Error("Session cursor does not match its sort");
  }
}

function addTextFilter(
  clauses: string[],
  dialect: FinalizedSessionSqlDialect,
  column: Extract<
    FinalizedSessionColumn,
    "browser" | "city" | "country" | "device" | "entry_url" | "os" | "region"
  >,
  value: string | undefined,
): void {
  if (value === undefined) return;
  clauses.push(`${dialect.column(column)} = ${dialect.text(value)}`);
}

function sessionSortExpression(
  sort: Exclude<SessionSort, "pages">,
  dialect: FinalizedSessionSqlDialect,
): string {
  switch (sort) {
    case "newest":
      return dialect.column("started_at");
    case "friction":
      return frictionSql(dialect);
    case "duration":
      return dialect.column("duration_ms");
    case "clicks":
      return dialect.column("clicks");
  }
}

function frictionSql(dialect: FinalizedSessionSqlDialect): string {
  return `(${dialect.column("errors")} * 1000 + ${dialect.column("rages")} * 100 + ${dialect.column("clicks")})`;
}

function frictionScore(values: { errors: number; rages: number; clicks: number }): number {
  return values.errors * 1000 + values.rages * 100 + values.clicks;
}

function parseCursorNumber(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
