import type {
  FilteredNumber,
  FilteredOptionalNumber,
  FinalizedProjectStats,
  SessionFilter,
  SessionListItem,
  StatsBreakdownRow,
  StatsErrorGroup,
} from "@orange-replay/shared";
import { encodeSessionCursor, type SessionListOptions } from "../query/session-query.ts";
import type { StatsDimension } from "./d1-stats.ts";
import {
  AnalyticsReadError,
  runR2SqlProjectQuery,
  type R2SqlMetrics,
  type R2SqlSettings,
} from "./r2-sql-client.ts";
import {
  buildWarehouseErrorEvidenceQuery,
  buildWarehouseSessionsQuery,
  buildWarehouseStatsQuery,
  type AnalyticsDeletionTableVersion,
  type WarehouseErrorEvidenceRow,
  type WarehouseStatsRow,
} from "./warehouse-query.ts";

export interface WarehouseSessionPage {
  sessions: SessionListItem[];
  nextBefore: string | null;
  warehouseVersion: number;
  metrics: R2SqlMetrics;
}

export interface WarehouseStatsResult {
  stats: FinalizedProjectStats;
  warehouseVersion: number;
  metrics: R2SqlMetrics;
}

export interface WarehouseErrorEvidenceResult {
  errors: Map<string, { count: number; affectedSessions: number }>;
  metrics: R2SqlMetrics;
}

export async function readWarehouseSessionPage(
  settings: R2SqlSettings,
  projectId: string,
  warehouseVersion: number,
  options: SessionListOptions,
  deletionTableVersion: AnalyticsDeletionTableVersion = "v1",
): Promise<WarehouseSessionPage> {
  const query = buildWarehouseSessionsQuery(
    projectId,
    warehouseVersion,
    options,
    deletionTableVersion,
  );
  const result = await runR2SqlProjectQuery<Record<string, unknown>>(
    settings,
    projectId,
    query.sql,
  );
  const sessions = result.rows.map(readSessionRow);
  const lastSession = sessions.at(-1);

  return {
    sessions,
    nextBefore:
      lastSession !== undefined && sessions.length >= options.limit
        ? encodeSessionCursor(lastSession, options.sort)
        : null,
    warehouseVersion,
    metrics: result.metrics,
  };
}

export async function readWarehouseProjectStats(
  settings: R2SqlSettings,
  projectId: string,
  warehouseVersion: number,
  filter: SessionFilter,
  deletionTableVersion: AnalyticsDeletionTableVersion = "v1",
): Promise<WarehouseStatsResult> {
  const query = buildWarehouseStatsQuery(projectId, warehouseVersion, filter, deletionTableVersion);
  const result = await runR2SqlProjectQuery<WarehouseStatsRow>(settings, projectId, query.sql);

  return {
    stats: readStatsRows(result.rows, filter),
    warehouseVersion,
    metrics: result.metrics,
  };
}

export async function readWarehouseErrorEvidence(
  settings: R2SqlSettings,
  projectId: string,
  warehouseVersion: number,
  filter: SessionFilter,
  details: readonly string[],
  deletionTableVersion: AnalyticsDeletionTableVersion = "v1",
): Promise<WarehouseErrorEvidenceResult> {
  const query = buildWarehouseErrorEvidenceQuery(
    projectId,
    warehouseVersion,
    filter,
    details,
    deletionTableVersion,
  );
  const result = await runR2SqlProjectQuery<WarehouseErrorEvidenceRow>(
    settings,
    projectId,
    query.sql,
  );
  const errors = new Map<string, { count: number; affectedSessions: number }>();
  for (const row of result.rows) {
    const detail = requiredText(row.label);
    if (errors.has(detail)) throw badWarehouseAnswer();
    errors.set(detail, {
      count: requiredCount(row.event_count),
      affectedSessions: requiredCount(row.affected_sessions),
    });
  }
  return { errors, metrics: result.metrics };
}

export function readStatsRows(
  rows: readonly Record<string, unknown>[],
  filter: SessionFilter,
): FinalizedProjectStats {
  const aggregateRows = rows.filter((row) => row.row_kind === "aggregate");
  if (aggregateRows.length !== 1) {
    throw badWarehouseAnswer();
  }

  const aggregate = aggregateRows[0];
  if (aggregate === undefined) throw badWarehouseAnswer();
  const sessionCount = requiredCount(aggregate.session_count);
  const includedSessions = optionalCount(aggregate.included_sessions);
  const insightSessions = optionalCount(aggregate.insight_sessions);
  const rageSessions = optionalCount(aggregate.rage_sessions);
  const quickBackSessions = optionalCount(aggregate.quick_back_sessions);
  const totalPages = optionalNumber(aggregate.total_pages) ?? 0;
  const pageCoverageFilter: SessionFilter = { ...filter, has_page_coverage: true };
  const insightFilter: SessionFilter = { ...filter, has_insights: true };
  const rageFilter: SessionFilter = { ...filter, has_rage: true };
  const quickBackFilter: SessionFilter = { ...filter, has_quick_back: true };

  const breakdowns = readBreakdowns(rows, filter, sessionCount);
  const errors = readErrors(rows, filter);

  return {
    filter: { ...filter },
    sessions: filteredNumber(sessionCount, filter),
    duration: {
      average: filteredNumber(optionalNumber(aggregate.average_duration_ms) ?? 0, filter),
      p50: filteredNumber(optionalNumber(aggregate.p50_duration_ms) ?? 0, filter),
    },
    clicks: filteredNumber(optionalNumber(aggregate.total_clicks) ?? 0, filter),
    pagesPerSession: {
      value: includedSessions === 0 ? null : totalPages / includedSessions,
      filter: { ...pageCoverageFilter },
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
        optionalNumber(aggregate.average_interaction_time_ms),
        insightFilter,
      ),
      averageMaxScrollDepth: filteredOptionalNumber(
        optionalNumber(aggregate.average_max_scroll_depth),
        insightFilter,
      ),
      includedSessions: filteredNumber(insightSessions, insightFilter),
      totalSessions: filteredNumber(sessionCount, filter),
    },
    breakdowns,
    errors,
  };
}

function readBreakdowns(
  rows: readonly Record<string, unknown>[],
  filter: SessionFilter,
  totalSessions: number,
): FinalizedProjectStats["breakdowns"] {
  const result: FinalizedProjectStats["breakdowns"] = {
    country: [],
    region: [],
    device: [],
    browser: [],
    os: [],
    entryPage: [],
  };

  for (const row of rows) {
    if (row.row_kind === "aggregate" || row.row_kind === "error") continue;
    if (row.row_kind !== "breakdown") throw badWarehouseAnswer();

    const label = requiredText(row.label);
    const count = requiredCount(row.session_count);
    const groupName = requiredText(row.group_name);
    const target = breakdownTarget(groupName);
    const rowFilter = breakdownFilter(filter, groupName, label);
    const item: StatsBreakdownRow = {
      label,
      filter: { ...rowFilter },
      count: filteredNumber(count, rowFilter),
      share: filteredNumber(totalSessions === 0 ? 0 : count / totalSessions, rowFilter),
    };
    result[target].push(item);
    if (result[target].length > 5) throw badWarehouseAnswer();
  }

  return result;
}

function readErrors(
  rows: readonly Record<string, unknown>[],
  filter: SessionFilter,
): StatsErrorGroup[] {
  const errors: StatsErrorGroup[] = [];
  for (const row of rows) {
    if (row.row_kind !== "error") continue;
    if (row.group_name !== "error") throw badWarehouseAnswer();

    const detail = requiredText(row.label);
    const errorFilter: SessionFilter = { ...filter, error_detail: detail };
    errors.push({
      detail,
      filter: { ...errorFilter },
      count: filteredNumber(requiredCount(row.event_count), errorFilter),
      affectedSessions: filteredNumber(requiredCount(row.affected_sessions), errorFilter),
    });
    if (errors.length > 5) throw badWarehouseAnswer();
  }
  return errors;
}

function breakdownTarget(
  groupName: string,
): "country" | "region" | "device" | "browser" | "os" | "entryPage" {
  switch (groupName) {
    case "country":
    case "region":
    case "device":
    case "browser":
    case "os":
      return groupName;
    case "entry_page":
      return "entryPage";
    default:
      throw badWarehouseAnswer();
  }
}

function breakdownFilter(filter: SessionFilter, groupName: string, label: string): SessionFilter {
  if (groupName === "entry_page") return { ...filter, entry_url: label };
  const dimension = groupName as StatsDimension;
  return { ...filter, [dimension]: label };
}

function readSessionRow(row: Record<string, unknown>): SessionListItem {
  return {
    session_id: requiredText(row.session_id),
    project_id: requiredText(row.project_id),
    org_id: requiredText(row.org_id),
    started_at: requiredWholeNumber(row.started_at),
    ended_at: requiredWholeNumber(row.ended_at),
    duration_ms: requiredWholeNumber(row.duration_ms),
    country: nullableText(row.country),
    region: nullableText(row.region),
    city: nullableText(row.city),
    device: nullableText(row.device),
    browser: nullableText(row.browser),
    os: nullableText(row.os),
    entry_url: nullableText(row.entry_url),
    url_count: requiredWholeNumber(row.url_count),
    page_count: nullableWholeNumber(row.page_count),
    analytics_version: requiredWholeNumber(row.analytics_version),
    max_scroll_depth: nullableNumber(row.max_scroll_depth),
    quick_backs: nullableWholeNumber(row.quick_backs),
    interaction_time_ms: nullableWholeNumber(row.interaction_time_ms),
    activity_hist: nullableText(row.activity_hist),
    clicks: requiredWholeNumber(row.clicks),
    errors: requiredWholeNumber(row.errors),
    rages: requiredWholeNumber(row.rages),
    navs: requiredWholeNumber(row.navs),
    bytes: requiredWholeNumber(row.bytes),
    segment_count: requiredWholeNumber(row.segment_count),
    flags: requiredWholeNumber(row.flags),
    manifest_key: requiredText(row.manifest_key),
    expires_at: requiredWholeNumber(row.expires_at),
  };
}

function filteredNumber(value: number, filter: SessionFilter): FilteredNumber {
  return { value, filter: { ...filter } };
}

function filteredOptionalNumber(
  value: number | null,
  filter: SessionFilter,
): FilteredOptionalNumber {
  return { value, filter: { ...filter } };
}

function requiredText(value: unknown): string {
  if (typeof value !== "string") throw badWarehouseAnswer();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return requiredText(value);
}

function requiredCount(value: unknown): number {
  const number = optionalNumber(value);
  if (number === null || !Number.isSafeInteger(number) || number < 0) {
    throw badWarehouseAnswer();
  }
  return number;
}

function optionalCount(value: unknown): number {
  return value === null ? 0 : requiredCount(value);
}

function requiredWholeNumber(value: unknown): number {
  return requiredCount(value);
}

function nullableWholeNumber(value: unknown): number | null {
  if (value === null) return null;
  return requiredWholeNumber(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  const number = optionalNumber(value);
  if (number === null) throw badWarehouseAnswer();
  return number;
}

function optionalNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  throw badWarehouseAnswer();
}

function badWarehouseAnswer(): AnalyticsReadError {
  return new AnalyticsReadError(
    "analytics_response_invalid",
    "Analytics returned an invalid answer.",
    { canRetry: true },
  );
}
