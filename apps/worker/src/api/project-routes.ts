import {
  MAX_CONFIG_UPDATE_BODY_BYTES,
  startWideEvent,
  withDefaultAnalyticsDateRange,
} from "@orange-replay/shared";
import { listProjectPresence, readProjectInstallStatus } from "../do/presence-client.ts";
import { liveSessionsFromPresenceRows } from "../do/presence-logic.ts";
import { shardDb, type Env } from "../env.ts";
import { AnalyticsReadError } from "../analytics/r2-sql-client.ts";
import {
  ANALYTICS_COMPARE_QUERY_TIMEOUT_MS,
  canCompareD1Exactly,
  runAnalyticsCompareInBackground,
  type AnalyticsCompareEvent,
} from "../analytics/compare.ts";
import { projectAnalyticsReadMode } from "../analytics/residency.ts";
import { r2SqlSettingsFromEnv, readWarehouseSnapshot } from "../analytics/runtime.ts";
import {
  readWarehouseErrorEvidence,
  readWarehouseProjectStats,
} from "../analytics/warehouse-read.ts";
import { demoRateLimitAllows, readDemoConfig } from "./auth.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "./http.ts";
import {
  parseProjectConfigUpdate,
  readProjectKeys,
  readStoredProjectConfig,
  writeStoredProjectConfig,
} from "./project-config.ts";
import {
  countFilteredLiveSessions,
  parseStatsFilter,
  readCachedFinalizedStats,
  readFinalizedProjectStats,
  statsCacheRequests,
  withLiveNow,
  writeFinalizedStatsCache,
  type FinalizedProjectStats,
} from "./stats.ts";

export async function getDemoDiscovery(
  request: Request,
  env: Env,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const demo = readDemoConfig(env);
  if (demo === null) return jsonError("not_found", 404);

  wideEvent.set({ project_id: demo.projectId, auth_mode: "demo" });
  if (!(await demoRateLimitAllows(env, request))) {
    wideEvent.set({ rate_limit: "demo" });
    return jsonError("rate_limited", 429);
  }

  return jsonResponse(
    { projectId: demo.projectId, writeKey: demo.writeKey },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}

export async function listLiveSessions(
  env: Env,
  projectId: string,
  requestId: string,
): Promise<Response> {
  const now = Date.now();
  const body = await listProjectPresence(env, projectId, requestId, now);
  if (body === null) return jsonError("presence_unavailable", 503);
  return jsonResponse({
    sessions: liveSessionsFromPresenceRows(body.sessions, now),
  });
}

export async function getProjectConfig(env: Env, projectId: string): Promise<Response> {
  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);
  return jsonResponse(config);
}

export async function putProjectConfig(
  request: Request,
  env: Env,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, MAX_CONFIG_UPDATE_BODY_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);

  const parsed = parseProjectConfigUpdate(body.value);
  if (!parsed.ok) {
    return jsonError(parsed.error, 400);
  }

  const result = await writeStoredProjectConfig(env, projectId, parsed.value);
  if (result.status === "not_found") return jsonError("not_found", 404);
  if (result.status === "version_conflict") return jsonError("config_version_conflict", 409);

  wideEvent.set({ config_version: result.config.version });
  return jsonResponse(result.config);
}

export async function getInstallStatus(
  env: Env,
  projectId: string,
  requestId: string,
): Promise<Response> {
  const status = await readProjectInstallStatus(env, projectId, requestId);
  if (status === null) return jsonError("presence_unavailable", 503);
  return jsonResponse(status);
}

export async function getProjectKeys(
  env: Env,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const keys = await readProjectKeys(env, projectId);
  wideEvent.set({ key_count: keys.length });
  return jsonResponse({ keys });
}

export async function getProjectStats(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  projectId: string,
  requestId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  wideEvent.set({ cache_hit: false });
  const parsed = parseStatsFilter(url.searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const now = Date.now();
  const readMode = await projectAnalyticsReadMode(env, projectId);
  if (!readMode.ok) return jsonError(readMode.error, readMode.status);
  const backend = readMode.backend;
  const filter =
    backend === "d1" ? parsed.filter : withDefaultAnalyticsDateRange(parsed.filter, now);
  if (backend === "d1") {
    const [finalized, presence] = await Promise.all([
      readFinalizedProjectStats(env, projectId, filter),
      listProjectPresence(env, projectId, requestId, now),
    ]);
    if (presence === null) return jsonError("presence_unavailable", 503);
    const liveNow = countFilteredLiveSessions(presence.sessions, filter, now);
    return jsonResponse(
      { ...withLiveNow(finalized, liveNow), analyticsState: readMode.state },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  if (backend === "compare") {
    const snapshot = await readWarehouseSnapshot(
      shardDb(env, 0),
      projectId,
      filter.warehouse_version,
    );
    if (!snapshot.ok && snapshot.error === "invalid_warehouse_version") {
      return jsonError(snapshot.error, snapshot.status);
    }
    const compareFilter = snapshot.ok ? { ...filter, warehouse_version: snapshot.version } : filter;
    const [d1Stats, presence] = await Promise.all([
      readFinalizedProjectStats(env, projectId, compareFilter),
      listProjectPresence(env, projectId, requestId, now),
    ]);
    if (presence === null) return jsonError("presence_unavailable", 503);

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
          compareFilter,
          d1Stats,
          compareEvent,
        );
      },
    );
    const liveNow = countFilteredLiveSessions(presence.sessions, compareFilter, now);

    return jsonResponse(
      {
        ...withLiveNow(d1Stats, liveNow),
        ...(snapshot.ok ? { warehouseVersion: snapshot.version } : {}),
        analyticsState: "compare",
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const snapshot = await readWarehouseSnapshot(
    shardDb(env, 0),
    projectId,
    filter.warehouse_version,
  );
  if (!snapshot.ok) return jsonError(snapshot.error, snapshot.status);
  const versionedFilter = { ...filter, warehouse_version: snapshot.version };
  const cacheRequests = statsCacheRequests(
    projectId,
    versionedFilter,
    snapshot.privacyVersion,
    filter.warehouse_version !== undefined,
  );
  const currentCache = await readCachedFinalizedStats(cacheRequests.current, snapshot.version);
  let finalized = currentCache?.value ?? null;
  let responseWarehouseVersion = currentCache?.warehouseVersion ?? snapshot.version;
  let analyticsState: "fresh" | "stale" = "fresh";
  const cacheHit = currentCache !== null;
  wideEvent.set({
    cache_hit: cacheHit,
    analytics_cache_state: cacheHit ? "current" : "miss",
  });
  let statsBytesScanned = 0;
  let statsFilesScanned = 0;

  try {
    if (finalized === null) {
      const warehouse = await readWarehouseProjectStats(
        r2SqlSettingsFromEnv(env),
        projectId,
        snapshot.version,
        versionedFilter,
      );
      finalized = warehouse.stats;
      statsBytesScanned = warehouse.metrics.bytesScanned;
      statsFilesScanned = warehouse.metrics.filesScanned;
      wideEvent.set({
        analytics_bytes_scanned: statsBytesScanned,
        analytics_files_scanned: statsFilesScanned,
        warehouse_version: snapshot.version,
      });
      writeFinalizedStatsCache(ctx, cacheRequests, finalized, snapshot.version);
    }
  } catch (error) {
    if (!(error instanceof AnalyticsReadError)) throw error;

    const lastGood = await readCachedFinalizedStats(cacheRequests.lastGood);
    if (lastGood === null) return jsonError("analytics_unavailable", 503);
    finalized = lastGood.value;
    responseWarehouseVersion = lastGood.warehouseVersion;
    analyticsState = "stale";
    wideEvent.set({
      cache_hit: true,
      analytics_cache_state: "stale",
      warehouse_version: responseWarehouseVersion,
    });
  }

  const presence = await listProjectPresence(env, projectId, requestId, now);
  if (presence === null) return jsonError("presence_unavailable", 503);
  const liveNow = countFilteredLiveSessions(presence.sessions, finalized.filter, now);

  return jsonResponse(
    {
      ...withLiveNow(finalized, liveNow),
      warehouseVersion: responseWarehouseVersion,
      analyticsState,
    },
    {
      headers: { "cache-control": "private, no-store" },
    },
  );
}

async function compareProjectStats(
  env: Env,
  projectId: string,
  warehouseVersion: number,
  filter: Parameters<typeof readFinalizedProjectStats>[2],
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
