import {
  encodeSessionFilter,
  parseSessionFilterQuery,
  sessionFilterQueryKeys,
  type SessionFilter,
} from "@orange-replay/shared";
import { buildSessionWhere, UNKNOWN_ERROR_DETAIL, type SessionQueryValue } from "./helpers.ts";
import type { Env } from "../env.ts";
import type { PresenceSession } from "../do/presence-logic.ts";
import {
  readAnalyticsCache,
  writeAnalyticsCache,
  type AnalyticsCacheRequests,
  type CachedAnalyticsResult,
} from "./analytics-cache.ts";

const TOP_BREAKDOWN_ROWS = 5;
const statsFilterKeys = new Set<string>(sessionFilterQueryKeys);

export type StatsDimension = "country" | "region" | "device" | "browser" | "os";

export interface FilteredNumber {
  value: number;
  filter: SessionFilter;
}

export interface FilteredOptionalNumber {
  value: number | null;
  filter: SessionFilter;
}

export interface StatsBreakdownRow {
  label: string;
  filter: SessionFilter;
  count: FilteredNumber;
  share: FilteredNumber;
}

export interface StatsErrorGroup {
  detail: string;
  filter: SessionFilter;
  count: FilteredNumber;
  affectedSessions: FilteredNumber;
}

export interface FinalizedProjectStats {
  filter: SessionFilter;
  sessions: FilteredNumber;
  duration: {
    average: FilteredNumber;
    p50: FilteredNumber;
  };
  clicks: FilteredNumber;
  pagesPerSession: {
    value: number | null;
    filter: SessionFilter;
    includedSessions: FilteredNumber;
    totalSessions: FilteredNumber;
  };
  insights: {
    ragePercent: FilteredOptionalNumber;
    quickBackPercent: FilteredOptionalNumber;
    averageInteractionTimeMs: FilteredOptionalNumber;
    averageMaxScrollDepth: FilteredOptionalNumber;
    includedSessions: FilteredNumber;
    totalSessions: FilteredNumber;
  };
  breakdowns: {
    country: StatsBreakdownRow[];
    region: StatsBreakdownRow[];
    device: StatsBreakdownRow[];
    browser: StatsBreakdownRow[];
    os: StatsBreakdownRow[];
    entryPage: StatsBreakdownRow[];
  };
  errors: StatsErrorGroup[];
}

export interface ProjectStats extends FinalizedProjectStats {
  liveNow: FilteredNumber;
}

export interface StatsQuery {
  sql: string;
  bindings: SessionQueryValue[];
}

export type ParsedStatsFilter = { ok: true; filter: SessionFilter } | { ok: false; error: string };

interface AggregateRow {
  session_count: number;
  average_duration_ms: number | null;
  total_clicks: number | null;
  included_sessions: number;
  total_pages: number | null;
  insight_sessions: number;
  rage_sessions: number;
  quick_back_sessions: number;
  average_interaction_time_ms: number | null;
  average_max_scroll_depth: number | null;
}

interface MedianRow {
  p50_duration_ms: number | null;
}

interface BreakdownRow {
  label: string;
  session_count: number;
}

interface ErrorGroupRow {
  detail: string;
  event_count: number;
  affected_sessions: number;
}

export function parseStatsFilter(params: URLSearchParams): ParsedStatsFilter {
  for (const key of params.keys()) {
    if (!statsFilterKeys.has(key)) {
      return { ok: false, error: `invalid_${key}` };
    }
  }

  return parseSessionFilterQuery(params);
}

export function buildAggregateStatsQuery(projectId: string, filter: SessionFilter): StatsQuery {
  const where = buildSessionWhere(projectId, filter, undefined, "s");
  return {
    sql: `SELECT COUNT(*) AS session_count, AVG(s.duration_ms) AS average_duration_ms, SUM(s.clicks) AS total_clicks, SUM(CASE WHEN s.analytics_version >= 1 AND s.page_count IS NOT NULL THEN 1 ELSE 0 END) AS included_sessions, SUM(CASE WHEN s.analytics_version >= 1 THEN s.page_count END) AS total_pages, SUM(CASE WHEN s.analytics_version >= 2 THEN 1 ELSE 0 END) AS insight_sessions, SUM(CASE WHEN s.analytics_version >= 2 AND s.rages > 0 THEN 1 ELSE 0 END) AS rage_sessions, SUM(CASE WHEN s.analytics_version >= 2 AND s.quick_backs > 0 THEN 1 ELSE 0 END) AS quick_back_sessions, AVG(CASE WHEN s.analytics_version >= 2 THEN s.interaction_time_ms END) AS average_interaction_time_ms, AVG(CASE WHEN s.analytics_version >= 2 THEN s.max_scroll_depth END) AS average_max_scroll_depth FROM sessions s WHERE ${where.sql}`,
    bindings: where.bindings,
  };
}

export function buildMedianDurationQuery(
  projectId: string,
  filter: SessionFilter,
  sessionCount: number,
): StatsQuery {
  const where = buildSessionWhere(projectId, filter, undefined, "s");
  const even = sessionCount % 2 === 0;
  const limit = even ? 2 : 1;
  const offset = even ? Math.max(0, sessionCount / 2 - 1) : Math.floor(sessionCount / 2);
  return {
    sql: `SELECT AVG(duration_ms) AS p50_duration_ms FROM (SELECT s.duration_ms FROM sessions s WHERE ${where.sql} ORDER BY s.duration_ms ASC LIMIT ? OFFSET ?)`,
    bindings: [...where.bindings, limit, offset],
  };
}

export function buildBreakdownQuery(
  projectId: string,
  filter: SessionFilter,
  dimension: StatsDimension,
): StatsQuery {
  const where = buildSessionWhere(projectId, filter, undefined, "s");
  return {
    sql: `SELECT s.${dimension} AS label, COUNT(*) AS session_count FROM sessions s WHERE ${where.sql} AND s.${dimension} IS NOT NULL AND s.${dimension} <> ? GROUP BY s.${dimension} ORDER BY session_count DESC, label ASC LIMIT ?`,
    bindings: [...where.bindings, "", TOP_BREAKDOWN_ROWS],
  };
}

export function buildEntryPageCandidatesQuery(
  projectId: string,
  filter: SessionFilter,
): StatsQuery {
  const where = buildSessionWhere(projectId, filter, undefined, "s");
  return {
    sql: `SELECT s.entry_url AS label, COUNT(*) AS session_count FROM sessions s WHERE ${where.sql} AND s.entry_url IS NOT NULL AND s.entry_url <> ? GROUP BY s.entry_url ORDER BY session_count DESC, label ASC LIMIT ?`,
    bindings: [...where.bindings, "", TOP_BREAKDOWN_ROWS],
  };
}

export function buildErrorGroupsQuery(projectId: string, filter: SessionFilter): StatsQuery {
  const where = buildSessionWhere(projectId, filter, undefined, "s");
  const selectedDetailSql =
    filter.error_detail === undefined ? "" : " AND COALESCE(e.detail, ?) = ?";
  return {
    sql: `SELECT COALESCE(e.detail, ?) AS detail, COUNT(*) AS event_count, COUNT(DISTINCT e.session_id) AS affected_sessions FROM session_events e INNER JOIN sessions s ON s.project_id = e.project_id AND s.session_id = e.session_id WHERE ${where.sql} AND e.kind = ?${selectedDetailSql} GROUP BY COALESCE(e.detail, ?) ORDER BY affected_sessions DESC, event_count DESC, detail ASC LIMIT ?`,
    bindings: [
      UNKNOWN_ERROR_DETAIL,
      ...where.bindings,
      "error",
      ...(filter.error_detail === undefined ? [] : [UNKNOWN_ERROR_DETAIL, filter.error_detail]),
      UNKNOWN_ERROR_DETAIL,
      TOP_BREAKDOWN_ROWS,
    ],
  };
}

export async function readFinalizedProjectStats(
  env: Pick<Env, "IDX_00">,
  projectId: string,
  filter: SessionFilter,
): Promise<FinalizedProjectStats> {
  const dimensions = ["country", "region", "device", "browser", "os"] as const;
  const aggregateQuery = buildAggregateStatsQuery(projectId, filter);
  const entryCandidatesQuery = buildEntryPageCandidatesQuery(projectId, filter);
  const errorGroupsQuery = buildErrorGroupsQuery(projectId, filter);

  const [aggregate, dimensionRows, entryCandidatesResult, errorGroupsResult] = await Promise.all([
    env.IDX_00.prepare(aggregateQuery.sql)
      .bind(...aggregateQuery.bindings)
      .first<AggregateRow>(),
    Promise.all(
      dimensions.map(async (dimension) => {
        const query = buildBreakdownQuery(projectId, filter, dimension);
        const result = await env.IDX_00.prepare(query.sql)
          .bind(...query.bindings)
          .all<BreakdownRow>();
        return result.results ?? [];
      }),
    ),
    env.IDX_00.prepare(entryCandidatesQuery.sql)
      .bind(...entryCandidatesQuery.bindings)
      .all<BreakdownRow>(),
    env.IDX_00.prepare(errorGroupsQuery.sql)
      .bind(...errorGroupsQuery.bindings)
      .all<ErrorGroupRow>(),
  ]);

  const aggregateRow = aggregate ?? emptyAggregateRow();
  const sessionCount = numberOrZero(aggregateRow.session_count);
  const entryCandidates = entryCandidatesResult.results ?? [];
  const median = await readMedianDuration(env.IDX_00, projectId, filter, sessionCount);
  const entryPageRows = makeEntryPageRows(filter, entryCandidates, sessionCount);

  const breakdowns = Object.fromEntries(
    dimensions.map((dimension, index) => [
      dimension,
      makeBreakdownRows(filter, dimension, dimensionRows[index] ?? [], sessionCount),
    ]),
  ) as Pick<FinalizedProjectStats["breakdowns"], StatsDimension>;
  const totalPages = numberOrZero(aggregateRow.total_pages);
  const includedSessions = numberOrZero(aggregateRow.included_sessions);
  const insightSessions = numberOrZero(aggregateRow.insight_sessions);
  const rageSessions = numberOrZero(aggregateRow.rage_sessions);
  const quickBackSessions = numberOrZero(aggregateRow.quick_back_sessions);
  const pageCoverageFilter: SessionFilter = { ...filter, has_page_coverage: true };
  const insightFilter: SessionFilter = { ...filter, has_insights: true };
  const rageFilter: SessionFilter = { ...filter, has_rage: true };
  const quickBackFilter: SessionFilter = { ...filter, has_quick_back: true };

  return {
    filter: copyFilter(filter),
    sessions: filteredNumber(sessionCount, filter),
    duration: {
      average: filteredNumber(numberOrZero(aggregateRow.average_duration_ms), filter),
      p50: filteredNumber(median, filter),
    },
    clicks: filteredNumber(numberOrZero(aggregateRow.total_clicks), filter),
    pagesPerSession: {
      value: includedSessions === 0 ? null : totalPages / includedSessions,
      filter: copyFilter(pageCoverageFilter),
      includedSessions: filteredNumber(includedSessions, pageCoverageFilter),
      totalSessions: filteredNumber(sessionCount, filter),
    },
    insights: {
      ragePercent: filteredOptionalNumber(
        insightSessions === 0 ? null : rageSessions / insightSessions,
        rageFilter,
      ),
      quickBackPercent: filteredOptionalNumber(
        insightSessions === 0 ? null : quickBackSessions / insightSessions,
        quickBackFilter,
      ),
      averageInteractionTimeMs: filteredOptionalNumber(
        numberOrNull(aggregateRow.average_interaction_time_ms),
        insightFilter,
      ),
      averageMaxScrollDepth: filteredOptionalNumber(
        numberOrNull(aggregateRow.average_max_scroll_depth),
        insightFilter,
      ),
      includedSessions: filteredNumber(insightSessions, insightFilter),
      totalSessions: filteredNumber(sessionCount, filter),
    },
    breakdowns: { ...breakdowns, entryPage: entryPageRows },
    errors: makeErrorGroups(filter, errorGroupsResult.results ?? []),
  };
}

export function countFilteredLiveSessions(
  sessions: readonly PresenceSession[],
  filter: SessionFilter,
  now: number,
): number {
  if (
    filter.region !== undefined ||
    filter.has_errors !== undefined ||
    filter.error_detail !== undefined ||
    filter.has_page_coverage !== undefined ||
    filter.has_rage !== undefined ||
    filter.has_quick_back !== undefined ||
    filter.has_insights !== undefined
  ) {
    return 0;
  }

  return sessions.filter((session) => {
    const duration = Math.max(0, now - session.started_at);
    return (
      (filter.from === undefined || session.started_at >= filter.from) &&
      (filter.to === undefined || session.started_at <= filter.to) &&
      (filter.country === undefined || session.country === filter.country) &&
      (filter.device === undefined || session.device === filter.device) &&
      (filter.browser === undefined || session.browser === filter.browser) &&
      (filter.os === undefined || session.os === filter.os) &&
      (filter.entry_url === undefined || session.entry_url === filter.entry_url) &&
      (filter.entry_url_prefix === undefined ||
        session.entry_url?.startsWith(filter.entry_url_prefix) === true) &&
      (filter.min_duration_ms === undefined || duration >= filter.min_duration_ms)
    );
  }).length;
}

export function withLiveNow(finalized: FinalizedProjectStats, liveNow: number): ProjectStats {
  return {
    ...finalized,
    liveNow: filteredNumber(liveNow, finalized.filter),
  };
}

export function statsCacheRequest(
  projectId: string,
  filter: SessionFilter,
  privacyVersion?: number,
): Request {
  const params = encodeSessionFilter(filter);
  if (privacyVersion !== undefined) {
    params.set("privacy_version", String(privacyVersion));
  }
  return cacheRequest(
    `https://orange-replay-stats-cache.internal/v1/projects/${encodeURIComponent(projectId)}/stats`,
    params,
  );
}

export function statsCacheRequests(
  projectId: string,
  filter: SessionFilter,
  privacyVersion: number,
  warehouseVersionWasRequested: boolean,
): AnalyticsCacheRequests {
  const currentParams = encodeSessionFilter(filter);
  const currentVersion = filter.warehouse_version ?? 0;
  currentParams.set("warehouse_version", String(currentVersion));
  currentParams.set("privacy_version", String(privacyVersion));

  const lastGoodParams = new URLSearchParams(currentParams);
  if (!warehouseVersionWasRequested) {
    lastGoodParams.delete("warehouse_version");
  }

  const projectPath = encodeURIComponent(projectId);
  return {
    current: cacheRequest(
      `https://orange-replay-stats-cache.internal/v1/projects/${projectPath}/stats`,
      currentParams,
    ),
    lastGood: cacheRequest(
      `https://orange-replay-stats-cache.internal/v1/projects/${projectPath}/stats-last-good`,
      lastGoodParams,
    ),
  };
}

export async function readCachedFinalizedStats(
  request: Request,
  expectedWarehouseVersion?: number,
): Promise<CachedAnalyticsResult<FinalizedProjectStats> | null> {
  return readAnalyticsCache<FinalizedProjectStats>(request, expectedWarehouseVersion);
}

export function writeFinalizedStatsCache(
  ctx: ExecutionContext,
  requests: AnalyticsCacheRequests,
  stats: FinalizedProjectStats,
  warehouseVersion: number,
): void {
  writeAnalyticsCache(ctx, requests, stats, warehouseVersion);
}

function cacheRequest(baseUrl: string, params: URLSearchParams): Request {
  const query = params.toString();
  return new Request(query.length === 0 ? baseUrl : `${baseUrl}?${query}`);
}

async function readMedianDuration(
  db: D1Database,
  projectId: string,
  filter: SessionFilter,
  sessionCount: number,
): Promise<number> {
  if (sessionCount === 0) return 0;
  const query = buildMedianDurationQuery(projectId, filter, sessionCount);
  const row = await db
    .prepare(query.sql)
    .bind(...query.bindings)
    .first<MedianRow>();
  return numberOrZero(row?.p50_duration_ms);
}

function makeEntryPageRows(
  filter: SessionFilter,
  candidates: readonly BreakdownRow[],
  totalSessions: number,
): StatsBreakdownRow[] {
  return candidates.map((candidate) => {
    const rowFilter: SessionFilter = { ...filter, entry_url: candidate.label };
    return makeBreakdownRow(candidate.label, rowFilter, candidate.session_count, totalSessions);
  });
}

function makeBreakdownRows(
  filter: SessionFilter,
  dimension: StatsDimension,
  rows: readonly BreakdownRow[],
  totalSessions: number,
): StatsBreakdownRow[] {
  return rows.map((row) => {
    const rowFilter = { ...filter, [dimension]: row.label } satisfies SessionFilter;
    return makeBreakdownRow(row.label, rowFilter, row.session_count, totalSessions);
  });
}

function makeBreakdownRow(
  label: string,
  filter: SessionFilter,
  count: number,
  totalSessions: number,
): StatsBreakdownRow {
  return {
    label,
    filter: copyFilter(filter),
    count: filteredNumber(count, filter),
    share: filteredNumber(totalSessions === 0 ? 0 : count / totalSessions, filter),
  };
}

function makeErrorGroups(filter: SessionFilter, rows: readonly ErrorGroupRow[]): StatsErrorGroup[] {
  return rows.map((row) => {
    const errorFilter: SessionFilter = { ...filter, error_detail: row.detail };
    return {
      detail: row.detail,
      filter: copyFilter(errorFilter),
      count: filteredNumber(numberOrZero(row.event_count), errorFilter),
      affectedSessions: filteredNumber(numberOrZero(row.affected_sessions), errorFilter),
    };
  });
}

function filteredNumber(value: number, filter: SessionFilter): FilteredNumber {
  return { value, filter: copyFilter(filter) };
}

function filteredOptionalNumber(
  value: number | null,
  filter: SessionFilter,
): FilteredOptionalNumber {
  return { value, filter: copyFilter(filter) };
}

function copyFilter(filter: SessionFilter): SessionFilter {
  return { ...filter };
}

function numberOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emptyAggregateRow(): AggregateRow {
  return {
    session_count: 0,
    average_duration_ms: null,
    total_clicks: null,
    included_sessions: 0,
    total_pages: null,
    insight_sessions: 0,
    rage_sessions: 0,
    quick_back_sessions: 0,
    average_interaction_time_ms: null,
    average_max_scroll_depth: null,
  };
}
