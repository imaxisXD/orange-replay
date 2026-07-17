import type { SessionFilter } from "@orange-replay/shared";
import { sessionRowColumns } from "../query/session-query.ts";
import {
  UNKNOWN_ERROR_DETAIL,
  buildFinalizedSessionCursorSql,
  buildFinalizedSessionFilterSql,
  checkSessionCursorSort,
  checkedSessionSort,
  finalizedSessionFilterNeedsErrorRows,
  finalizedSessionOrderSql,
  type FinalizedSessionColumn,
  type FinalizedSessionSqlDialect,
  type SessionListOptions,
} from "../query/finalized-session-semantics.ts";
import { sqlAllowedName, sqlText, sqlWholeNumber } from "./sql.ts";

export const analyticsTableNames = {
  sessions: "analytics_sessions",
  events: "analytics_events",
  deletions: "analytics_deletions",
  deletionsV2: "analytics_deletions_v2",
} as const;

export const analyticsQualifiedTableNames = {
  sessions: `"default"."${analyticsTableNames.sessions}"`,
  events: `"default"."${analyticsTableNames.events}"`,
  deletions: `"default"."${analyticsTableNames.deletions}"`,
  deletionsV2: `"default"."${analyticsTableNames.deletionsV2}"`,
} as const;

export type AnalyticsDeletionTableVersion = "v1" | "v2";

const analyticsSessionColumns = [
  "export_id",
  "export_sequence",
  "schema_version",
  "recorded_at",
  "event_coverage",
  ...sessionRowColumns,
] as const;

const analyticsEventColumns = [
  "export_id",
  "export_sequence",
  "schema_version",
  "recorded_at",
  "project_id",
  "session_id",
  "event_index",
  "event_time",
  "event_kind",
  "event_detail",
] as const;

const analyticsDeletionColumns = [
  "export_id",
  "export_sequence",
  "schema_version",
  "recorded_at",
  "project_id",
  "session_id",
  "deleted_at",
  "delete_reason",
] as const;

const analyticsDeletionV2Columns = [
  "export_id",
  "export_sequence",
  "schema_version",
  "recorded_at",
  "project_id",
  "session_id",
  "session_started_at",
  "deleted_at",
  "delete_reason",
] as const;

const allowedBreakdownColumns = [
  "country",
  "region",
  "device",
  "browser",
  "os",
  "entry_url",
] as const;

// Must stay equal to TOP_BREAKDOWN_ROWS in d1-stats.ts: D1 and warehouse
// answers are compared row-for-row for parity.
export const TOP_STATS_ROWS = 30;

export interface WarehouseProjectQuery {
  projectId: string;
  warehouseVersion: number;
  sql: string;
}

export interface WarehouseStatsRow extends Record<string, unknown> {
  project_id: string;
  row_kind: "aggregate" | "breakdown" | "error";
  group_name: string | null;
  label: string | null;
  /** Country code carried by city breakdown rows; NULL everywhere else. */
  dimension_country: string | null;
  session_count: number | null;
  event_count: number | null;
  affected_sessions: number | null;
  average_duration_ms: number | null;
  p50_duration_ms: number | null;
  total_clicks: number | null;
  included_sessions: number | null;
  total_pages: number | null;
  insight_sessions: number | null;
  rage_sessions: number | null;
  quick_back_sessions: number | null;
  average_interaction_time_ms: number | null;
  average_max_scroll_depth: number | null;
}

export interface WarehouseErrorEvidenceRow extends Record<string, unknown> {
  project_id: string;
  label: string;
  event_count: number;
  affected_sessions: number;
}

export function buildWarehouseSessionsQuery(
  projectId: string,
  warehouseVersion: number,
  options: SessionListOptions,
  deletionTableVersion: AnalyticsDeletionTableVersion = "v1",
): WarehouseProjectQuery {
  checkProject(projectId);
  const version = sqlWholeNumber(warehouseVersion, "Warehouse version");
  const limit = sqlWholeNumber(options.limit, "Session limit");
  if (options.limit < 1 || options.limit > 100) {
    throw new Error("Session limit must be between 1 and 100");
  }

  const sort = checkedSessionSort(options.sort);
  checkSessionCursorSort(options.before, sort);
  const includeEvents = finalizedSessionFilterNeedsErrorRows(options);
  const ctes = buildWarehouseCtes(projectId, version, includeEvents, options, deletionTableVersion);
  const filterSql = buildFilterSql(projectId, options, includeEvents);
  const dialect = warehouseSessionDialect(includeEvents);
  const cursorSql = buildFinalizedSessionCursorSql(sort, options.before, dialect) ?? "TRUE";
  const orderSql = finalizedSessionOrderSql(sort, dialect);

  return {
    projectId,
    warehouseVersion,
    sql: `${ctes},
filtered_sessions AS (
  SELECT ${selectColumns("s", sessionRowColumns)}
  FROM live_sessions s
  WHERE ${filterSql}
)
SELECT ${selectColumns("s", sessionRowColumns)}
FROM filtered_sessions s
WHERE ${cursorSql}
ORDER BY ${orderSql}
LIMIT ${limit}`,
  };
}

export function buildWarehouseStatsQuery(
  projectId: string,
  warehouseVersion: number,
  filter: SessionFilter,
  deletionTableVersion: AnalyticsDeletionTableVersion = "v1",
): WarehouseProjectQuery {
  checkProject(projectId);
  const version = sqlWholeNumber(warehouseVersion, "Warehouse version");
  const project = sqlText(projectId);
  const ctes = buildWarehouseCtes(projectId, version, true, filter, deletionTableVersion);
  const filterSql = buildFilterSql(projectId, filter, true);
  const selectedErrorDetail =
    filter.error_detail === undefined
      ? ""
      : ` AND COALESCE(e.event_detail, ${sqlText(UNKNOWN_ERROR_DETAIL)}) = ${sqlText(filter.error_detail)}`;

  const breakdownParts = allowedBreakdownColumns.map((column) => {
    const safeColumn = sqlAllowedName(column, allowedBreakdownColumns, "breakdown");
    const groupName = column === "entry_url" ? "entry_page" : column;
    return `SELECT ${sqlText(groupName)} AS group_name, s.${safeColumn} AS label, CAST(NULL AS VARCHAR) AS dimension_country
    FROM filtered_sessions s
    WHERE s.${safeColumn} IS NOT NULL AND s.${safeColumn} <> ''`;
  });
  // City is the one two-column dimension: grouped by (country, city) so the
  // row filter can pin both keys and the dashboard can render a flag.
  breakdownParts.push(`SELECT 'city' AS group_name, s.city AS label, s.country AS dimension_country
    FROM filtered_sessions s
    WHERE s.city IS NOT NULL AND s.city <> '' AND s.country IS NOT NULL AND s.country <> ''`);

  return {
    projectId,
    warehouseVersion,
    sql: `${ctes},
filtered_sessions AS (
  SELECT ${selectColumns("s", sessionRowColumns)}
  FROM live_sessions s
  WHERE ${filterSql}
),
aggregate_stats AS (
  SELECT
    COUNT(*) AS session_count,
    AVG(s.duration_ms) AS average_duration_ms,
    MEDIAN(s.duration_ms) AS p50_duration_ms,
    SUM(s.clicks) AS total_clicks,
    SUM(CASE WHEN s.analytics_version >= 1 AND s.page_count IS NOT NULL THEN 1 ELSE 0 END) AS included_sessions,
    SUM(CASE WHEN s.analytics_version >= 1 THEN s.page_count END) AS total_pages,
    SUM(CASE WHEN s.analytics_version >= 2 THEN 1 ELSE 0 END) AS insight_sessions,
    SUM(CASE WHEN s.analytics_version >= 2 AND s.rages > 0 THEN 1 ELSE 0 END) AS rage_sessions,
    SUM(CASE WHEN s.analytics_version >= 2 AND s.quick_backs > 0 THEN 1 ELSE 0 END) AS quick_back_sessions,
    AVG(CASE WHEN s.analytics_version >= 2 THEN s.interaction_time_ms END) AS average_interaction_time_ms,
    AVG(CASE WHEN s.analytics_version >= 2 THEN s.max_scroll_depth END) AS average_max_scroll_depth
  FROM filtered_sessions s
),
breakdown_candidates AS (
  ${breakdownParts.join("\n  UNION ALL\n  ")}
),
breakdown_counts AS (
  SELECT group_name, label, dimension_country, COUNT(*) AS session_count
  FROM breakdown_candidates
  GROUP BY group_name, label, dimension_country
),
ranked_breakdowns AS (
  SELECT
    group_name,
    label,
    dimension_country,
    session_count,
    ROW_NUMBER() OVER (
      PARTITION BY group_name
      ORDER BY session_count DESC, label ASC, dimension_country ASC
    ) AS group_rank
  FROM breakdown_counts
),
error_counts AS (
  SELECT
    COALESCE(e.event_detail, ${sqlText(UNKNOWN_ERROR_DETAIL)}) AS label,
    COUNT(*) AS event_count,
    COUNT(DISTINCT e.session_id) AS affected_sessions
  FROM latest_events e
  INNER JOIN filtered_sessions s
    ON s.project_id = e.project_id AND s.session_id = e.session_id
  WHERE e.event_kind = 'error'${selectedErrorDetail}
  GROUP BY COALESCE(e.event_detail, ${sqlText(UNKNOWN_ERROR_DETAIL)})
),
ranked_errors AS (
  SELECT
    label,
    event_count,
    affected_sessions,
    ROW_NUMBER() OVER (
      ORDER BY affected_sessions DESC, event_count DESC, label ASC
    ) AS error_rank
  FROM error_counts
),
stats_rows AS (
  SELECT
    ${project} AS project_id,
    'aggregate' AS row_kind,
    CAST(NULL AS VARCHAR) AS group_name,
    CAST(NULL AS VARCHAR) AS label,
    CAST(NULL AS VARCHAR) AS dimension_country,
    a.session_count,
    CAST(NULL AS BIGINT) AS event_count,
    CAST(NULL AS BIGINT) AS affected_sessions,
    a.average_duration_ms,
    a.p50_duration_ms,
    a.total_clicks,
    a.included_sessions,
    a.total_pages,
    a.insight_sessions,
    a.rage_sessions,
    a.quick_back_sessions,
    a.average_interaction_time_ms,
    a.average_max_scroll_depth
  FROM aggregate_stats a

  UNION ALL

  SELECT
    ${project} AS project_id,
    'breakdown' AS row_kind,
    b.group_name,
    b.label,
    b.dimension_country,
    b.session_count,
    CAST(NULL AS BIGINT) AS event_count,
    CAST(NULL AS BIGINT) AS affected_sessions,
    CAST(NULL AS DOUBLE) AS average_duration_ms,
    CAST(NULL AS DOUBLE) AS p50_duration_ms,
    CAST(NULL AS BIGINT) AS total_clicks,
    CAST(NULL AS BIGINT) AS included_sessions,
    CAST(NULL AS BIGINT) AS total_pages,
    CAST(NULL AS BIGINT) AS insight_sessions,
    CAST(NULL AS BIGINT) AS rage_sessions,
    CAST(NULL AS BIGINT) AS quick_back_sessions,
    CAST(NULL AS DOUBLE) AS average_interaction_time_ms,
    CAST(NULL AS DOUBLE) AS average_max_scroll_depth
  FROM ranked_breakdowns b
  WHERE b.group_rank <= ${TOP_STATS_ROWS}

  UNION ALL

  SELECT
    ${project} AS project_id,
    'error' AS row_kind,
    'error' AS group_name,
    e.label,
    CAST(NULL AS VARCHAR) AS dimension_country,
    CAST(NULL AS BIGINT) AS session_count,
    e.event_count,
    e.affected_sessions,
    CAST(NULL AS DOUBLE) AS average_duration_ms,
    CAST(NULL AS DOUBLE) AS p50_duration_ms,
    CAST(NULL AS BIGINT) AS total_clicks,
    CAST(NULL AS BIGINT) AS included_sessions,
    CAST(NULL AS BIGINT) AS total_pages,
    CAST(NULL AS BIGINT) AS insight_sessions,
    CAST(NULL AS BIGINT) AS rage_sessions,
    CAST(NULL AS BIGINT) AS quick_back_sessions,
    CAST(NULL AS DOUBLE) AS average_interaction_time_ms,
    CAST(NULL AS DOUBLE) AS average_max_scroll_depth
  FROM ranked_errors e
  WHERE e.error_rank <= ${TOP_STATS_ROWS}
)
SELECT *
FROM stats_rows
ORDER BY
  CASE row_kind WHEN 'aggregate' THEN 0 WHEN 'breakdown' THEN 1 ELSE 2 END,
  group_name ASC,
  session_count DESC,
  affected_sessions DESC,
  event_count DESC,
  label ASC,
  dimension_country ASC`,
  };
}

export function buildWarehouseErrorEvidenceQuery(
  projectId: string,
  warehouseVersion: number,
  filter: SessionFilter,
  details: readonly string[],
  deletionTableVersion: AnalyticsDeletionTableVersion = "v1",
): WarehouseProjectQuery {
  checkProject(projectId);
  if (filter.error_detail !== undefined) {
    throw new Error("Compare evidence does not accept an error detail filter");
  }
  if (details.length < 1 || details.length > TOP_STATS_ROWS) {
    throw new Error(`Compare evidence needs between 1 and ${TOP_STATS_ROWS} error details`);
  }
  const uniqueDetails = [...new Set(details)];
  if (uniqueDetails.length !== details.length) {
    throw new Error("Compare evidence error details must be unique");
  }

  const version = sqlWholeNumber(warehouseVersion, "Warehouse version");
  const project = sqlText(projectId);
  const ctes = buildWarehouseCtes(projectId, version, true, filter, deletionTableVersion);
  const filterSql = buildFilterSql(projectId, filter, true);
  const detailList = uniqueDetails.map((detail) => sqlText(detail)).join(", ");

  return {
    projectId,
    warehouseVersion,
    sql: `${ctes},
filtered_sessions AS (
  SELECT ${selectColumns("s", sessionRowColumns)}
  FROM live_sessions s
  WHERE ${filterSql}
)
SELECT
  ${project} AS project_id,
  COALESCE(e.event_detail, ${sqlText(UNKNOWN_ERROR_DETAIL)}) AS label,
  COUNT(*) AS event_count,
  COUNT(DISTINCT e.session_id) AS affected_sessions
FROM latest_events e
INNER JOIN filtered_sessions s
  ON s.project_id = e.project_id AND s.session_id = e.session_id
WHERE e.event_kind = 'error'
  AND COALESCE(e.event_detail, ${sqlText(UNKNOWN_ERROR_DETAIL)}) IN (${detailList})
GROUP BY COALESCE(e.event_detail, ${sqlText(UNKNOWN_ERROR_DETAIL)})
ORDER BY label ASC`,
  };
}

function buildWarehouseCtes(
  projectId: string,
  version: string,
  includeEvents: boolean,
  filter: SessionFilter,
  deletionTableVersion: AnalyticsDeletionTableVersion,
): string {
  if (filter.from === undefined && filter.to === undefined) {
    throw new Error("Analytics date range is required");
  }

  const project = sqlText(projectId);
  const { error_detail: _eventFilter, ...sessionOnlyFilter } = filter;
  const baseSessionFilter = buildFilterSql(projectId, sessionOnlyFilter, false);
  const sessionsTable = analyticsQualifiedTableNames.sessions;
  const deletionCtes = buildDeletionCtes(project, filter, deletionTableVersion);

  // The Pipeline sink already rejects rows missing required fields. Repeating
  // that full null-check list here makes Cloudflare R2 SQL exceed its current
  // expression-depth limit before the query can run.
  const sessionCtes = `WITH scoped_session_exports AS (
  SELECT
    ${selectColumns("s", analyticsSessionColumns)},
    ROW_NUMBER() OVER (
      PARTITION BY s.project_id, s.export_id
      ORDER BY s.export_sequence DESC, s.recorded_at DESC
    ) AS export_retry_rank
  FROM ${sessionsTable} s
  WHERE s.project_id = ${project}
    AND s.export_sequence <= ${version}
),
one_session_export AS (
  SELECT ${selectColumns("s", analyticsSessionColumns)}
  FROM scoped_session_exports s
  WHERE s.export_retry_rank = 1
),
ranked_sessions AS (
  SELECT
    ${selectColumns("s", analyticsSessionColumns)},
    ROW_NUMBER() OVER (
      PARTITION BY s.project_id, s.session_id
      ORDER BY s.export_sequence DESC, s.recorded_at DESC, s.export_id DESC
    ) AS session_rank
  FROM one_session_export s
),
${deletionCtes},
live_sessions AS (
  SELECT ${selectColumns("s", sessionRowColumns)}
  FROM ranked_sessions s
  WHERE s.session_rank = 1
    AND (${baseSessionFilter})
    AND NOT EXISTS (
      SELECT 1
      FROM deleted_sessions d
      WHERE d.project_id = s.project_id AND d.session_id = s.session_id
    )
)`;

  if (!includeEvents) return sessionCtes;

  const eventsTable = analyticsQualifiedTableNames.events;
  return `${sessionCtes},
scoped_event_exports AS (
  SELECT
    ${selectColumns("e", analyticsEventColumns)},
    ROW_NUMBER() OVER (
      PARTITION BY e.project_id, e.export_id
      ORDER BY e.export_sequence DESC, e.recorded_at DESC
    ) AS export_retry_rank
  FROM ${eventsTable} e
  INNER JOIN live_sessions target_session
    ON target_session.project_id = e.project_id AND target_session.session_id = e.session_id
  WHERE e.project_id = ${project}
    AND e.export_sequence <= ${version}
    AND e.event_kind = 'error'
),
latest_events AS (
  SELECT ${selectColumns("e", analyticsEventColumns)}
  FROM scoped_event_exports e
  WHERE e.export_retry_rank = 1
)`;
}

function buildDeletionCtes(
  project: string,
  filter: SessionFilter,
  version: AnalyticsDeletionTableVersion,
): string {
  if (version === "v1") {
    return `scoped_deletion_exports AS (
  SELECT
    ${selectColumns("d", analyticsDeletionColumns)},
    ROW_NUMBER() OVER (
      PARTITION BY d.project_id, d.export_id
      ORDER BY d.export_sequence DESC, d.recorded_at DESC
    ) AS export_retry_rank
  FROM ${analyticsQualifiedTableNames.deletions} d
  WHERE d.project_id = ${project}
),
deleted_sessions AS (
  SELECT DISTINCT d.project_id, d.session_id
  FROM scoped_deletion_exports d
  WHERE d.export_retry_rank = 1
)`;
  }

  const rangeClauses = [
    filter.from === undefined
      ? undefined
      : `(d.session_started_at IS NULL OR d.session_started_at >= ${sqlWholeNumber(filter.from, "Start time")})`,
    filter.to === undefined
      ? undefined
      : `(d.session_started_at IS NULL OR d.session_started_at <= ${sqlWholeNumber(filter.to, "End time")})`,
  ].filter((clause): clause is string => clause !== undefined);

  return `scoped_deletion_exports AS (
  SELECT
    ${selectColumns("d", analyticsDeletionV2Columns)},
    ROW_NUMBER() OVER (
      PARTITION BY d.project_id, d.export_id
      ORDER BY d.export_sequence DESC, d.recorded_at DESC
    ) AS export_retry_rank
  FROM ${analyticsQualifiedTableNames.deletionsV2} d
  WHERE d.project_id = ${project}
    AND d.schema_version = 2
    AND ${rangeClauses.join("\n    AND ")}
),
deleted_sessions AS (
  SELECT DISTINCT d.project_id, d.session_id
  FROM scoped_deletion_exports d
  WHERE d.export_retry_rank = 1
)`;
}

function buildFilterSql(
  projectId: string,
  filter: SessionFilter,
  eventsAreAvailable: boolean,
): string {
  const clauses = [
    `s.project_id = ${sqlText(projectId)}`,
    ...buildFinalizedSessionFilterSql(filter, warehouseSessionDialect(eventsAreAvailable)),
  ];
  return clauses.join(" AND ");
}

const warehouseSessionColumns = {
  analytics_version: "s.analytics_version",
  browser: 's."browser"',
  city: 's."city"',
  clicks: "s.clicks",
  country: 's."country"',
  device: 's."device"',
  duration_ms: "s.duration_ms",
  entry_url: 's."entry_url"',
  errors: "s.errors",
  os: 's."os"',
  page_count: "s.page_count",
  quick_backs: "s.quick_backs",
  rages: "s.rages",
  region: 's."region"',
  session_id: "s.session_id",
  started_at: "s.started_at",
} as const satisfies Record<FinalizedSessionColumn, string>;

function warehouseSessionDialect(eventsAreAvailable: boolean): FinalizedSessionSqlDialect {
  return {
    column(name) {
      return warehouseSessionColumns[name];
    },
    wholeNumber(value, label) {
      return sqlWholeNumber(value, label);
    },
    text(value) {
      return sqlText(value);
    },
    entryUrlPrefix(prefixValue) {
      const prefix = sqlText(prefixValue);
      return `substr(s.entry_url, 1, length(${prefix})) = ${prefix}`;
    },
    errorDetail(detail, unknownDetail, eventKind) {
      if (!eventsAreAvailable) {
        throw new Error("Error details need the analytics events table");
      }
      return `EXISTS (
      SELECT 1
      FROM latest_events e
      WHERE e.project_id = s.project_id
        AND e.session_id = s.session_id
        AND e.event_kind = ${sqlText(eventKind)}
        AND COALESCE(e.event_detail, ${sqlText(unknownDetail)}) = ${sqlText(detail)}
    )`;
    },
    warehouseVersion() {
      // R2 applies the version while selecting and deduplicating exported rows.
      return undefined;
    },
  };
}

function checkProject(projectId: string): void {
  if (projectId.length === 0 || projectId.length > 200) {
    throw new Error("Analytics project id is not valid");
  }
}

function selectColumns(alias: string, columns: readonly string[]): string {
  return columns.map((column) => `${alias}."${column}"`).join(", ");
}
