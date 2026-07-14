import {
  encodeSessionFilter,
  manifestKey,
  sessionPrefix,
  startWideEvent,
  withDefaultAnalyticsDateRange,
} from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
import { AnalyticsReadError } from "../analytics/r2-sql-client.ts";
import {
  ANALYTICS_COMPARE_QUERY_TIMEOUT_MS,
  canCompareD1Exactly,
  runAnalyticsCompareInBackground,
} from "../analytics/compare.ts";
import { projectAnalyticsReadMode } from "../analytics/residency.ts";
import { r2SqlSettingsFromEnv, readWarehouseSnapshot } from "../analytics/runtime.ts";
import { readWarehouseSessionPage } from "../analytics/warehouse-read.ts";
import {
  readAnalyticsCache,
  writeAnalyticsCache,
  type AnalyticsCacheRequests,
} from "./analytics-cache.ts";
import type { ApiAuthMode } from "./auth.ts";
import {
  buildSessionsQuery,
  encodeSessionCursor,
  parseSessionListQuery,
  type SessionListOptions,
  type SessionRow,
} from "./helpers.ts";
import { jsonError, jsonResponse, secureHeaders } from "./http.ts";
import { sessionHasDeletionFence } from "./session-head-routes.ts";

const DEMO_SESSIONS_LIST_MAX = 50;

export async function listSessions(
  url: URL,
  env: Env,
  projectId: string,
  authMode: ApiAuthMode,
  requestId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
  ctx: ExecutionContext,
): Promise<Response> {
  const parsed = parseSessionListQuery(url.searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  const requestedOptions =
    authMode === "demo" && parsed.options.limit > DEMO_SESSIONS_LIST_MAX
      ? { ...parsed.options, limit: DEMO_SESSIONS_LIST_MAX }
      : parsed.options;
  const readMode = await projectAnalyticsReadMode(env, projectId);
  if (!readMode.ok) return jsonError(readMode.error, readMode.status);
  const backend = readMode.backend;
  const options =
    backend === "d1"
      ? requestedOptions
      : { ...requestedOptions, ...withDefaultAnalyticsDateRange(requestedOptions, Date.now()) };
  if (backend === "d1") {
    const page = await readD1SessionPage(env, projectId, options);
    return jsonResponse({ ...page, analyticsState: readMode.state });
  }

  if (backend === "compare") {
    const snapshot = await readWarehouseSnapshot(
      shardDb(env, 0),
      projectId,
      options.warehouse_version,
    );
    if (!snapshot.ok && snapshot.error === "invalid_warehouse_version") {
      return jsonError(snapshot.error, snapshot.status);
    }
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

    return jsonResponse({
      ...d1Page,
      ...(snapshot.ok ? { warehouseVersion: snapshot.version } : {}),
      analyticsState: "compare",
    });
  }

  const db = shardDb(env, 0);
  const snapshot = await readWarehouseSnapshot(db, projectId, options.warehouse_version);
  if (!snapshot.ok) return jsonError(snapshot.error, snapshot.status);
  const versionedOptions = { ...options, warehouse_version: snapshot.version };
  const cacheRequests = sessionCacheRequests(
    projectId,
    versionedOptions,
    snapshot.privacyVersion,
    options.warehouse_version !== undefined,
  );
  const currentCache = await readAnalyticsCache<SessionPage>(
    cacheRequests.current,
    snapshot.version,
  );

  if (currentCache !== null && safeCachedPage(currentCache.value, projectId)) {
    wideEvent.set({
      cache_hit: true,
      analytics_cache_state: "current",
      warehouse_version: currentCache.warehouseVersion,
    });
    return sessionPageResponse(currentCache.value, currentCache.warehouseVersion, "fresh");
  }

  wideEvent.set({ cache_hit: false, analytics_cache_state: "miss" });

  try {
    const warehousePage = await readWarehouseSessionPage(
      r2SqlSettingsFromEnv(env),
      projectId,
      snapshot.version,
      versionedOptions,
    );
    const page = {
      sessions: warehousePage.sessions,
      nextBefore: warehousePage.nextBefore,
    };
    writeAnalyticsCache(ctx, cacheRequests, page, snapshot.version);
    return sessionPageResponse(page, snapshot.version, "fresh");
  } catch (error) {
    if (!(error instanceof AnalyticsReadError)) throw error;

    const lastGood = await readAnalyticsCache<SessionPage>(cacheRequests.lastGood);
    if (lastGood === null || !safeCachedPage(lastGood.value, projectId)) {
      return jsonError("analytics_unavailable", 503);
    }

    wideEvent.set({
      cache_hit: true,
      analytics_cache_state: "stale",
      warehouse_version: lastGood.warehouseVersion,
    });
    return sessionPageResponse(lastGood.value, lastGood.warehouseVersion, "stale");
  }
}

interface SessionPage {
  sessions: SessionRow[];
  nextBefore: string | null;
}

export function sessionCacheRequests(
  projectId: string,
  options: SessionListOptions,
  privacyVersion: number,
  warehouseVersionWasRequested: boolean,
): AnalyticsCacheRequests {
  const { limit, sort, before, ...filter } = options;
  const currentParams = encodeSessionFilter(filter);
  currentParams.set("limit", String(limit));
  currentParams.set("sort", sort);
  if (before !== undefined) {
    currentParams.set("before", sessionCursorText(before));
  }
  currentParams.set("warehouse_version", String(options.warehouse_version ?? 0));
  currentParams.set("privacy_version", String(privacyVersion));

  const lastGoodParams = new URLSearchParams(currentParams);
  if (!warehouseVersionWasRequested) {
    lastGoodParams.delete("warehouse_version");
  }
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

function sessionPageResponse(
  page: SessionPage,
  warehouseVersion: number,
  analyticsState: "fresh" | "stale",
): Response {
  return jsonResponse({ ...page, warehouseVersion, analyticsState });
}

function safeCachedPage(value: unknown, projectId: string): value is SessionPage {
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

async function readD1SessionPage(
  env: Env,
  projectId: string,
  options: SessionListOptions,
): Promise<{ sessions: SessionRow[]; nextBefore: string | null }> {
  const query = buildSessionsQuery(projectId, options);
  const result = await shardDb(env, 0)
    .prepare(query.sql)
    .bind(...query.bindings)
    .all<SessionRow>();
  const sessions = result.results ?? [];
  const lastSession = sessions.at(-1);
  // A short page means the list is exhausted — no cursor, so clients can
  // render an honest count instead of a dangling "load more".
  const hasMore = lastSession !== undefined && sessions.length >= options.limit;

  return {
    sessions,
    nextBefore: hasMore ? encodeSessionCursor(lastSession, options.sort) : null,
  };
}

export function sameSessionPage(
  left: { sessions: SessionRow[]; nextBefore: string | null },
  right: { sessions: SessionRow[]; nextBefore: string | null },
): boolean {
  return (
    JSON.stringify(left) ===
    JSON.stringify({
      sessions: right.sessions,
      nextBefore: right.nextBefore,
    })
  );
}

export async function getManifest(
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<Response> {
  if (await sessionHasDeletionFence(env, projectId, sessionId)) {
    return jsonError("not_found", 404);
  }

  const object = await env.RECORDINGS.get(manifestKey(projectId, sessionId));
  if (object === null) return jsonError("not_found", 404);

  return new Response(object.body, {
    headers: secureHeaders({
      "content-type": "application/json",
      // Keep browser copies short-lived so a retention delete has a small,
      // documented cache bound as well as removing the R2 object.
      "cache-control": "private, max-age=300, must-revalidate",
      vary: "Authorization",
    }),
  });
}

export async function getSegment(
  env: Env,
  projectId: string,
  sessionId: string,
  name: string,
): Promise<Response> {
  if (await sessionHasDeletionFence(env, projectId, sessionId)) {
    return jsonError("not_found", 404);
  }

  const object = await env.RECORDINGS.get(`${sessionPrefix(projectId, sessionId)}/${name}`);
  if (object === null) return jsonError("not_found", 404);

  const response = new Response(object.body, {
    headers: secureHeaders({
      "content-type": "application/octet-stream",
      "cache-control": "private, max-age=300, must-revalidate",
      vary: "Authorization",
      etag: object.httpEtag,
    }),
  });

  return response;
}
