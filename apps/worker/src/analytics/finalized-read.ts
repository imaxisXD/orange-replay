import {
  encodeSessionFilter,
  startWideEvent,
  withDefaultAnalyticsDateRange,
  type AnalyticsState,
  type FinalizedProjectStats,
  type SessionFilter,
  type SessionListItem,
} from "@orange-replay/shared";
import {
  buildSessionsQuery,
  encodeSessionCursor,
  sessionRowToListItem,
  type SessionListOptions,
  type SessionRow,
} from "../query/session-query.ts";
import { readAnalyticsCache, writeAnalyticsCache, type AnalyticsCacheRequests } from "./cache.ts";
import { readFinalizedProjectStats } from "./d1-stats.ts";
import { analyticsDeletionReadVersion, shardDb, type Env } from "../env.ts";
import {
  ANALYTICS_COMPARE_QUERY_TIMEOUT_MS,
  canCompareD1Exactly,
  runAnalyticsCompareInBackground,
  type AnalyticsCompareEvent,
} from "./compare.ts";
import { AnalyticsReadError } from "./r2-sql-client.ts";
import { projectAnalyticsReadMode } from "./residency.ts";
import { r2SqlSettingsFromEnv, readWarehouseSnapshot } from "./runtime.ts";
import type { AnalyticsDeletionTableVersion } from "./warehouse-query.ts";
import {
  readWarehouseErrorEvidence,
  readWarehouseProjectStats,
  readWarehouseSessionPage,
} from "./warehouse-read.ts";

export interface FinalizedSessionPage {
  sessions: SessionListItem[];
  nextBefore: string | null;
}

export type FinalizedAnalyticsState = AnalyticsState;

export type FinalizedAnalyticsRead<Value> =
  | {
      ok: true;
      value: Value;
      analyticsState: FinalizedAnalyticsState;
      warehouseVersion?: number;
    }
  | {
      ok: false;
      error: string;
      status: 400 | 503;
    };

interface FinalizedSessionReadInput {
  env: Env;
  projectId: string;
  requestedOptions: SessionListOptions;
  requestId: string;
  wideEvent: ReturnType<typeof startWideEvent>;
  ctx: ExecutionContext;
  now: number;
}

interface FinalizedStatsReadInput {
  env: Env;
  projectId: string;
  requestedFilter: SessionFilter;
  requestId: string;
  wideEvent: ReturnType<typeof startWideEvent>;
  ctx: ExecutionContext;
  now: number;
}

/**
 * Owns the full finalized-session read policy. Callers do not choose a data
 * backend or rebuild snapshot, cache, stale-data, and compare behavior.
 */
export async function readFinalizedSessionPage(
  input: FinalizedSessionReadInput,
): Promise<FinalizedAnalyticsRead<FinalizedSessionPage>> {
  const { env, projectId, requestedOptions, requestId, wideEvent, ctx, now } = input;
  const readMode = await projectAnalyticsReadMode(env, projectId);
  if (!readMode.ok) return readMode;

  const options =
    readMode.backend === "d1"
      ? requestedOptions
      : { ...requestedOptions, ...withDefaultAnalyticsDateRange(requestedOptions, now) };

  if (readMode.backend === "d1") {
    return successfulRead(await readD1SessionPage(env, projectId, options), readMode.state);
  }

  if (readMode.backend === "compare") {
    return readComparedSessionPage({
      env,
      projectId,
      options,
      requestId,
      ctx,
    });
  }

  return readR2SessionPage({ env, projectId, options, wideEvent, ctx });
}

/**
 * Reads finalized stats only. Live presence is deliberately added by the
 * route after this module returns because it has a different consistency path.
 */
export async function readFinalizedStats(
  input: FinalizedStatsReadInput,
): Promise<FinalizedAnalyticsRead<FinalizedProjectStats>> {
  const { env, projectId, requestedFilter, requestId, wideEvent, ctx, now } = input;
  const readMode = await projectAnalyticsReadMode(env, projectId);
  if (!readMode.ok) return readMode;

  const filter =
    readMode.backend === "d1"
      ? requestedFilter
      : withDefaultAnalyticsDateRange(requestedFilter, now);

  if (readMode.backend === "d1") {
    return successfulRead(await readFinalizedProjectStats(env, projectId, filter), readMode.state);
  }

  if (readMode.backend === "compare") {
    return readComparedStats({ env, projectId, filter, requestId, ctx });
  }

  return readR2Stats({ env, projectId, filter, wideEvent, ctx });
}

async function readComparedSessionPage(input: {
  env: Env;
  projectId: string;
  options: SessionListOptions;
  requestId: string;
  ctx: ExecutionContext;
}): Promise<FinalizedAnalyticsRead<FinalizedSessionPage>> {
  const { env, projectId, options, requestId, ctx } = input;
  const snapshot = await readWarehouseSnapshot(
    shardDb(env, 0),
    projectId,
    options.warehouse_version,
    analyticsDeletionReadVersion(env),
  );
  if (!snapshot.ok && snapshot.error === "invalid_warehouse_version") return snapshot;

  const compareOptions = snapshot.ok
    ? { ...options, warehouse_version: snapshot.version }
    : options;
  const d1Page = await readD1SessionPage(env, projectId, compareOptions);

  runAnalyticsCompareInBackground(
    ctx,
    {
      projectId,
      requestId,
      route: "sessions_list",
      ...(snapshot.ok ? { warehouseVersion: snapshot.version } : {}),
    },
    async (compareEvent) => {
      if (!snapshot.ok) {
        compareEvent.set({
          analytics_compare_status: "unavailable",
          analytics_compare_error: snapshot.error,
        });
        return "server_error";
      }
      if (!canCompareD1Exactly(compareOptions)) {
        compareEvent.set({
          analytics_compare_status: "not_comparable",
          analytics_compare_reason: "d1_sparse_error_details",
        });
        return;
      }

      const warehousePage = await readWarehouseSessionPage(
        {
          ...r2SqlSettingsFromEnv(env),
          timeoutMs: ANALYTICS_COMPARE_QUERY_TIMEOUT_MS,
        },
        projectId,
        snapshot.version,
        compareOptions,
        snapshot.deletionTableVersion,
      );
      const matches = sameSessionPage(d1Page, warehousePage);
      compareEvent.set({
        analytics_compare_status: matches ? "match" : "mismatch",
        analytics_compare_match: matches,
        analytics_bytes_scanned: warehousePage.metrics.bytesScanned,
        analytics_files_scanned: warehousePage.metrics.filesScanned,
      });
    },
  );

  return successfulRead(d1Page, "compare", snapshot.ok ? snapshot.version : undefined);
}

async function readR2SessionPage(input: {
  env: Env;
  projectId: string;
  options: SessionListOptions;
  wideEvent: ReturnType<typeof startWideEvent>;
  ctx: ExecutionContext;
}): Promise<FinalizedAnalyticsRead<FinalizedSessionPage>> {
  const { env, projectId, options, wideEvent, ctx } = input;
  const snapshot = await readWarehouseSnapshot(
    shardDb(env, 0),
    projectId,
    options.warehouse_version,
    analyticsDeletionReadVersion(env),
  );
  if (!snapshot.ok) return snapshot;

  const versionedOptions = { ...options, warehouse_version: snapshot.version };
  const cacheRequests = sessionCacheRequests(
    projectId,
    versionedOptions,
    snapshot.privacyVersion,
    options.warehouse_version !== undefined,
    snapshot.deletionTableVersion,
  );
  const currentCache = await readAnalyticsCache<FinalizedSessionPage>(
    cacheRequests.current,
    snapshot.version,
  );

  if (currentCache !== null && safeCachedPage(currentCache.value, projectId)) {
    wideEvent.set({
      cache_hit: true,
      analytics_cache_state: "current",
      warehouse_version: currentCache.warehouseVersion,
    });
    return successfulRead(currentCache.value, "fresh", currentCache.warehouseVersion);
  }

  wideEvent.set({ cache_hit: false, analytics_cache_state: "miss" });

  try {
    const warehousePage = await readWarehouseSessionPage(
      r2SqlSettingsFromEnv(env),
      projectId,
      snapshot.version,
      versionedOptions,
      snapshot.deletionTableVersion,
    );
    const page = {
      sessions: warehousePage.sessions,
      nextBefore: warehousePage.nextBefore,
    };
    writeAnalyticsCache(ctx, cacheRequests, page, snapshot.version);
    return successfulRead(page, "fresh", snapshot.version);
  } catch (error) {
    if (!(error instanceof AnalyticsReadError)) throw error;

    const lastGood = await readAnalyticsCache<FinalizedSessionPage>(cacheRequests.lastGood);
    if (lastGood === null || !safeCachedPage(lastGood.value, projectId)) {
      return analyticsUnavailable();
    }

    wideEvent.set({
      cache_hit: true,
      analytics_cache_state: "stale",
      warehouse_version: lastGood.warehouseVersion,
    });
    return successfulRead(lastGood.value, "stale", lastGood.warehouseVersion);
  }
}

async function readComparedStats(input: {
  env: Env;
  projectId: string;
  filter: SessionFilter;
  requestId: string;
  ctx: ExecutionContext;
}): Promise<FinalizedAnalyticsRead<FinalizedProjectStats>> {
  const { env, projectId, filter, requestId, ctx } = input;
  const snapshot = await readWarehouseSnapshot(
    shardDb(env, 0),
    projectId,
    filter.warehouse_version,
    analyticsDeletionReadVersion(env),
  );
  if (!snapshot.ok && snapshot.error === "invalid_warehouse_version") return snapshot;

  const compareFilter = snapshot.ok ? { ...filter, warehouse_version: snapshot.version } : filter;
  const d1Stats = await readFinalizedProjectStats(env, projectId, compareFilter);

  runAnalyticsCompareInBackground(
    ctx,
    {
      projectId,
      requestId,
      route: "project_stats",
      ...(snapshot.ok ? { warehouseVersion: snapshot.version } : {}),
    },
    async (compareEvent) => {
      if (!snapshot.ok) {
        compareEvent.set({
          analytics_compare_status: "unavailable",
          analytics_compare_error: snapshot.error,
        });
        return "server_error";
      }
      await compareProjectStats(
        env,
        projectId,
        snapshot.version,
        snapshot.deletionTableVersion,
        compareFilter,
        d1Stats,
        compareEvent,
      );
    },
  );

  return successfulRead(d1Stats, "compare", snapshot.ok ? snapshot.version : undefined);
}

async function readR2Stats(input: {
  env: Env;
  projectId: string;
  filter: SessionFilter;
  wideEvent: ReturnType<typeof startWideEvent>;
  ctx: ExecutionContext;
}): Promise<FinalizedAnalyticsRead<FinalizedProjectStats>> {
  const { env, projectId, filter, wideEvent, ctx } = input;
  const snapshot = await readWarehouseSnapshot(
    shardDb(env, 0),
    projectId,
    filter.warehouse_version,
    analyticsDeletionReadVersion(env),
  );
  if (!snapshot.ok) return snapshot;

  const versionedFilter = { ...filter, warehouse_version: snapshot.version };
  const cacheRequests = statsCacheRequests(
    projectId,
    versionedFilter,
    snapshot.privacyVersion,
    filter.warehouse_version !== undefined,
    snapshot.deletionTableVersion,
  );
  const currentCache = await readAnalyticsCache<FinalizedProjectStats>(
    cacheRequests.current,
    snapshot.version,
  );
  let finalized = currentCache?.value ?? null;
  let responseWarehouseVersion = currentCache?.warehouseVersion ?? snapshot.version;
  let analyticsState: "fresh" | "stale" = "fresh";
  const cacheHit = currentCache !== null;
  wideEvent.set({
    cache_hit: cacheHit,
    analytics_cache_state: cacheHit ? "current" : "miss",
  });

  try {
    if (finalized === null) {
      const warehouse = await readWarehouseProjectStats(
        r2SqlSettingsFromEnv(env),
        projectId,
        snapshot.version,
        versionedFilter,
        snapshot.deletionTableVersion,
      );
      finalized = warehouse.stats;
      wideEvent.set({
        analytics_bytes_scanned: warehouse.metrics.bytesScanned,
        analytics_files_scanned: warehouse.metrics.filesScanned,
        warehouse_version: snapshot.version,
      });
      writeAnalyticsCache(ctx, cacheRequests, finalized, snapshot.version);
    }
  } catch (error) {
    if (!(error instanceof AnalyticsReadError)) throw error;

    const lastGood = await readAnalyticsCache<FinalizedProjectStats>(cacheRequests.lastGood);
    if (lastGood === null) return analyticsUnavailable();
    finalized = lastGood.value;
    responseWarehouseVersion = lastGood.warehouseVersion;
    analyticsState = "stale";
    wideEvent.set({
      cache_hit: true,
      analytics_cache_state: "stale",
      warehouse_version: responseWarehouseVersion,
    });
  }

  return successfulRead(finalized, analyticsState, responseWarehouseVersion);
}

async function compareProjectStats(
  env: Env,
  projectId: string,
  warehouseVersion: number,
  deletionTableVersion: AnalyticsDeletionTableVersion,
  filter: SessionFilter,
  d1Stats: FinalizedProjectStats,
  compareEvent: AnalyticsCompareEvent,
): Promise<void> {
  if (!canCompareD1Exactly(filter)) {
    compareEvent.set({
      analytics_compare_status: "not_comparable",
      analytics_compare_reason: "d1_sparse_error_details",
    });
    return;
  }

  const compareSettings = {
    ...r2SqlSettingsFromEnv(env),
    timeoutMs: ANALYTICS_COMPARE_QUERY_TIMEOUT_MS,
  };
  const warehouse = await readWarehouseProjectStats(
    compareSettings,
    projectId,
    warehouseVersion,
    filter,
    deletionTableVersion,
  );
  let matches = sameStatsWithoutErrors(d1Stats, warehouse.stats);
  let bytesScanned = warehouse.metrics.bytesScanned;
  let filesScanned = warehouse.metrics.filesScanned;

  if (matches && d1Stats.errors.length === 0) {
    matches = warehouse.stats.errors.length === 0;
  } else if (matches) {
    const evidence = await readWarehouseErrorEvidence(
      compareSettings,
      projectId,
      warehouseVersion,
      filter,
      d1Stats.errors.map((error) => error.detail),
      deletionTableVersion,
    );
    bytesScanned += evidence.metrics.bytesScanned;
    filesScanned += evidence.metrics.filesScanned;
    matches = warehouseIncludesD1Errors(d1Stats, evidence.errors);
  }

  compareEvent.set({
    analytics_compare_status: matches ? "match" : "mismatch",
    analytics_compare_match: matches,
    analytics_bytes_scanned: bytesScanned,
    analytics_files_scanned: filesScanned,
  });
}

async function readD1SessionPage(
  env: Env,
  projectId: string,
  options: SessionListOptions,
): Promise<FinalizedSessionPage> {
  const query = buildSessionsQuery(projectId, options);
  const result = await shardDb(env, 0)
    .prepare(query.sql)
    .bind(...query.bindings)
    .all<SessionRow>();
  const rows = result.results ?? [];
  const sessions = rows.map(sessionRowToListItem);
  const lastSession = sessions.at(-1);
  const hasMore = lastSession !== undefined && sessions.length >= options.limit;

  return {
    sessions,
    nextBefore: hasMore ? encodeSessionCursor(lastSession, options.sort) : null,
  };
}

export function sessionCacheRequests(
  projectId: string,
  options: SessionListOptions,
  privacyVersion: number,
  warehouseVersionWasRequested: boolean,
  deletionTableVersion: AnalyticsDeletionTableVersion = "v1",
): AnalyticsCacheRequests {
  const { limit, sort, before, ...filter } = options;
  const currentParams = encodeSessionFilter(filter);
  currentParams.set("limit", String(limit));
  currentParams.set("sort", sort);
  if (before !== undefined) currentParams.set("before", sessionCursorText(before));
  currentParams.set("warehouse_version", String(options.warehouse_version ?? 0));
  currentParams.set("privacy_version", String(privacyVersion));
  currentParams.set("deletion_table_version", deletionTableVersion);

  const lastGoodParams = new URLSearchParams(currentParams);
  if (!warehouseVersionWasRequested) lastGoodParams.delete("warehouse_version");
  const projectPath = encodeURIComponent(projectId);

  return {
    current: cacheRequest(
      `https://orange-replay-sessions-cache.internal/v1/projects/${projectPath}/sessions`,
      currentParams,
    ),
    lastGood: cacheRequest(
      `https://orange-replay-sessions-cache.internal/v1/projects/${projectPath}/sessions-last-good`,
      lastGoodParams,
    ),
  };
}

export function statsCacheRequests(
  projectId: string,
  filter: SessionFilter,
  privacyVersion: number,
  warehouseVersionWasRequested: boolean,
  deletionTableVersion: AnalyticsDeletionTableVersion = "v1",
): AnalyticsCacheRequests {
  const currentParams = encodeSessionFilter(filter);
  currentParams.set("warehouse_version", String(filter.warehouse_version ?? 0));
  currentParams.set("privacy_version", String(privacyVersion));
  currentParams.set("deletion_table_version", deletionTableVersion);

  const lastGoodParams = new URLSearchParams(currentParams);
  if (!warehouseVersionWasRequested) lastGoodParams.delete("warehouse_version");
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

export function sameSessionPage(left: FinalizedSessionPage, right: FinalizedSessionPage): boolean {
  return (
    JSON.stringify(left) ===
    JSON.stringify({
      sessions: right.sessions,
      nextBefore: right.nextBefore,
    })
  );
}

export function sameStatsWithoutErrors(
  d1: FinalizedProjectStats,
  warehouse: FinalizedProjectStats,
): boolean {
  if (!sameFilter(d1.filter, warehouse.filter)) return false;
  if (!sameFilteredWholeNumber(d1.sessions, warehouse.sessions)) return false;
  if (!sameFilteredWholeNumber(d1.clicks, warehouse.clicks)) return false;
  if (!sameFilteredNumber(d1.duration.average, warehouse.duration.average)) return false;
  if (!sameFilteredNumber(d1.duration.p50, warehouse.duration.p50)) return false;
  if (!nearNumber(d1.pagesPerSession.value, warehouse.pagesPerSession.value)) return false;
  if (!sameFilter(d1.pagesPerSession.filter, warehouse.pagesPerSession.filter)) return false;
  if (
    !sameFilteredWholeNumber(
      d1.pagesPerSession.includedSessions,
      warehouse.pagesPerSession.includedSessions,
    ) ||
    !sameFilteredWholeNumber(
      d1.pagesPerSession.totalSessions,
      warehouse.pagesPerSession.totalSessions,
    )
  ) {
    return false;
  }

  if (!sameFilteredNumber(d1.insights.ragePercent, warehouse.insights.ragePercent)) return false;
  if (!sameFilteredNumber(d1.insights.quickBackPercent, warehouse.insights.quickBackPercent)) {
    return false;
  }
  if (
    !sameFilteredNumber(
      d1.insights.averageInteractionTimeMs,
      warehouse.insights.averageInteractionTimeMs,
    ) ||
    !sameFilteredNumber(
      d1.insights.averageMaxScrollDepth,
      warehouse.insights.averageMaxScrollDepth,
    ) ||
    !sameFilteredWholeNumber(d1.insights.includedSessions, warehouse.insights.includedSessions) ||
    !sameFilteredWholeNumber(d1.insights.totalSessions, warehouse.insights.totalSessions)
  ) {
    return false;
  }

  for (const key of ["country", "region", "device", "browser", "os", "entryPage"] as const) {
    const left = d1.breakdowns[key];
    const right = warehouse.breakdowns[key];
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      const leftRow = left[index];
      const rightRow = right[index];
      if (
        leftRow === undefined ||
        rightRow === undefined ||
        leftRow.label !== rightRow.label ||
        !sameFilter(leftRow.filter, rightRow.filter) ||
        !sameFilteredWholeNumber(leftRow.count, rightRow.count) ||
        !sameFilteredNumber(leftRow.share, rightRow.share)
      ) {
        return false;
      }
    }
  }
  return true;
}

export function warehouseIncludesD1Errors(
  d1: FinalizedProjectStats,
  warehouse: ReadonlyMap<string, { count: number; affectedSessions: number }>,
): boolean {
  return d1.errors.every((error) => {
    const evidence = warehouse.get(error.detail);
    return (
      evidence !== undefined &&
      evidence.count >= error.count.value &&
      evidence.affectedSessions >= error.affectedSessions.value
    );
  });
}

function successfulRead<Value>(
  value: Value,
  analyticsState: FinalizedAnalyticsState,
  warehouseVersion?: number,
): FinalizedAnalyticsRead<Value> {
  return {
    ok: true,
    value,
    analyticsState,
    ...(warehouseVersion === undefined ? {} : { warehouseVersion }),
  };
}

function analyticsUnavailable(): FinalizedAnalyticsRead<never> {
  return { ok: false, error: "analytics_unavailable", status: 503 };
}

function safeCachedPage(value: unknown, projectId: string): value is FinalizedSessionPage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page["sessions"])) return false;
  if (page["nextBefore"] !== null && typeof page["nextBefore"] !== "string") return false;

  return page["sessions"].every((session) => {
    if (typeof session !== "object" || session === null || Array.isArray(session)) return false;
    const row = session as Record<string, unknown>;
    return row["project_id"] === projectId && typeof row["session_id"] === "string";
  });
}

function sessionCursorText(cursor: NonNullable<SessionListOptions["before"]>): string {
  if (cursor.sort === "newest") {
    return cursor.sessionId === undefined
      ? String(cursor.sortValue)
      : `${cursor.sortValue}:${cursor.sessionId}`;
  }
  const value = cursor.sortValue === null ? "null" : String(cursor.sortValue);
  return `${cursor.sort}:${value}:${cursor.sessionId}`;
}

function cacheRequest(baseUrl: string, params: URLSearchParams): Request {
  const query = params.toString();
  return new Request(query.length === 0 ? baseUrl : `${baseUrl}?${query}`);
}

function sameFilteredWholeNumber(
  left: { value: number; filter: object },
  right: { value: number; filter: object },
): boolean {
  return left.value === right.value && sameFilter(left.filter, right.filter);
}

function sameFilteredNumber(
  left: { value: number | null; filter: object },
  right: { value: number | null; filter: object },
): boolean {
  return nearNumber(left.value, right.value) && sameFilter(left.filter, right.filter);
}

function nearNumber(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Math.max(1e-6, scale * 1e-9);
}

function sameFilter(left: object, right: object): boolean {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(left).toSorted();
  const rightKeys = Object.keys(right).toSorted();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) => key === rightKeys[index] && leftRecord[key] === rightRecord[key],
  );
}
