import { startWideEvent, withDefaultAnalyticsDateRange } from "@orange-replay/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  readAnalyticsCache,
  writeAnalyticsCache,
  type AnalyticsCacheRequests,
} from "../src/api/analytics-cache.ts";
import { getProjectStats } from "../src/api/project-routes.ts";
import { listSessions, sessionCacheRequests } from "../src/api/session-routes.ts";
import { statsCacheRequests } from "../src/api/stats.ts";
import type { Env } from "../src/env.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("analytics last-good cache", () => {
  it("adds the shared date bound before a direct R2 SQL API read", async () => {
    installCache();
    vi.spyOn(Date, "now").mockReturnValue(100_001_000);
    const state = warehouseState();
    const env = warehouseEnv(state);
    const ctx = testContext();
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (typeof init.body !== "string") throw new Error("Expected an R2 SQL request body");
        const body = JSON.parse(init.body) as { query?: unknown };
        if (typeof body.query !== "string") throw new Error("Expected an R2 SQL query");
        queries.push(body.query);
        return body.query.includes("stats_rows AS")
          ? r2SqlResponse([statsRow("project_1")])
          : r2SqlResponse([sessionRow("project_1")]);
      }),
    );

    const statsResponse = await getProjectStats(
      new URL("https://replay.test/api/v1/projects/project_1/stats"),
      env,
      ctx.value,
      "project_1",
      "request_stats",
      startWideEvent("test", "stats"),
    );
    const sessionsResponse = await listSessions(
      new URL("https://replay.test/api/v1/projects/project_1/sessions"),
      env,
      "project_1",
      "bearer",
      startWideEvent("test", "sessions"),
      ctx.value,
    );

    expect(statsResponse.status).toBe(200);
    expect(sessionsResponse.status).toBe(200);
    expect(await statsResponse.json()).toMatchObject({
      sessions: {
        filter: { from: 13_560_000, to: 99_960_000, warehouse_version: 12 },
      },
    });
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toContain("s.started_at >= 13560000");
      expect(query).toContain("s.started_at <= 99960000");
    }
    await ctx.finish();
  });

  it("writes a short current result and a longer last-good result", async () => {
    const cache = installCache();
    const requests = testRequests();
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise);
      },
    } as Parameters<typeof writeAnalyticsCache>[0];

    writeAnalyticsCache(ctx, requests, { sessions: 4 }, 12);
    await Promise.all(waits);

    expect(cache.saved.get(requests.current.url)?.headers.get("cache-control")).toBe(
      "public, max-age=60",
    );
    expect(cache.saved.get(requests.lastGood.url)?.headers.get("cache-control")).toBe(
      "public, max-age=86400",
    );
    await expect(readAnalyticsCache(requests.current, 12)).resolves.toEqual({
      value: { sessions: 4 },
      warehouseVersion: 12,
    });
    await expect(readAnalyticsCache(requests.current, 13)).resolves.toBeNull();
    await expect(readAnalyticsCache(requests.lastGood)).resolves.toEqual({
      value: { sessions: 4 },
      warehouseVersion: 12,
    });
  });

  it("treats a missing or malformed last-good result as unavailable", async () => {
    const cache = installCache();
    const requests = testRequests();

    await expect(readAnalyticsCache(requests.lastGood)).resolves.toBeNull();

    cache.saved.set(requests.lastGood.url, Response.json({ warehouseVersion: 12, value: {} }));
    await expect(readAnalyticsCache(requests.lastGood)).resolves.toBeNull();
  });

  it("shares unpinned stats across data versions but isolates pins and privacy epochs", () => {
    const first = statsCacheRequests(
      "project_1",
      { country: "US", warehouse_version: 12 },
      0,
      false,
    );
    const newerData = statsCacheRequests(
      "project_1",
      { country: "US", warehouse_version: 13 },
      0,
      false,
    );
    const pinned = statsCacheRequests(
      "project_1",
      { country: "US", warehouse_version: 13 },
      0,
      true,
    );
    const afterDeletion = statsCacheRequests(
      "project_1",
      { country: "US", warehouse_version: 13 },
      13,
      false,
    );

    expect(first.current.url).not.toBe(newerData.current.url);
    expect(first.lastGood.url).toBe(newerData.lastGood.url);
    expect(pinned.lastGood.url).not.toBe(newerData.lastGood.url);
    expect(afterDeletion.lastGood.url).not.toBe(first.lastGood.url);
    const params = new URL(first.lastGood.url).searchParams;
    expect(params.has("warehouse_version")).toBe(false);
    expect(params.get("privacy_version")).toBe("0");
    expect(new URL(pinned.lastGood.url).searchParams.get("warehouse_version")).toBe("13");
  });

  it("scopes a cached session page by project, filters, cursor, and privacy epoch", () => {
    const base = sessionCacheRequests(
      "project_1",
      {
        country: "US",
        limit: 25,
        sort: "duration",
        before: { sort: "duration", sortValue: 5_000, sessionId: "session_2" },
        warehouse_version: 12,
      },
      0,
      false,
    );
    const otherProject = sessionCacheRequests(
      "project_2",
      {
        country: "US",
        limit: 25,
        sort: "duration",
        before: { sort: "duration", sortValue: 5_000, sessionId: "session_2" },
        warehouse_version: 12,
      },
      0,
      false,
    );
    const afterDeletion = sessionCacheRequests(
      "project_1",
      {
        country: "US",
        limit: 25,
        sort: "duration",
        before: { sort: "duration", sortValue: 5_000, sessionId: "session_2" },
        warehouse_version: 13,
      },
      13,
      false,
    );
    const pinned = sessionCacheRequests(
      "project_1",
      {
        country: "US",
        limit: 25,
        sort: "duration",
        before: { sort: "duration", sortValue: 5_000, sessionId: "session_2" },
        warehouse_version: 12,
      },
      0,
      true,
    );

    expect(base.lastGood.url).not.toBe(otherProject.lastGood.url);
    expect(base.lastGood.url).not.toBe(afterDeletion.lastGood.url);
    const params = new URL(base.lastGood.url).searchParams;
    expect(params.get("country")).toBe("US");
    expect(params.get("limit")).toBe("25");
    expect(params.get("sort")).toBe("duration");
    expect(params.get("before")).toBe("duration:5000:session_2");
    expect(params.has("warehouse_version")).toBe(false);
    expect(params.get("privacy_version")).toBe("0");
    expect(new URL(pinned.lastGood.url).searchParams.get("warehouse_version")).toBe("12");
  });

  it("uses prior unpinned stats after a version advance but isolates pins and privacy", async () => {
    installCache();
    const state = warehouseState();
    const env = warehouseEnv(state);
    const ctx = testContext();
    let r2IsDown = false;
    const r2Fetch = vi.fn(async () => {
      if (r2IsDown) throw new Error("R2 SQL is unavailable");
      return r2SqlResponse([statsRow("project_1")]);
    });
    vi.stubGlobal("fetch", r2Fetch);

    const fresh = await getProjectStats(
      new URL("https://replay.test/api/v1/projects/project_1/stats"),
      env,
      ctx.value,
      "project_1",
      "request_1",
      startWideEvent("test", "stats"),
    );
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({
      analyticsState: "fresh",
      warehouseVersion: 12,
      sessions: { value: 5 },
    });
    await ctx.finish();
    expect(r2Fetch).toHaveBeenCalledTimes(1);

    r2IsDown = true;
    const current = await getProjectStats(
      new URL("https://replay.test/api/v1/projects/project_1/stats"),
      env,
      ctx.value,
      "project_1",
      "request_2",
      startWideEvent("test", "stats"),
    );
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ analyticsState: "fresh", warehouseVersion: 12 });
    expect(r2Fetch).toHaveBeenCalledTimes(1);

    state.verifiedSequence = 13;
    const stale = await getProjectStats(
      new URL("https://replay.test/api/v1/projects/project_1/stats"),
      env,
      ctx.value,
      "project_1",
      "request_3",
      startWideEvent("test", "stats"),
    );
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ analyticsState: "stale", warehouseVersion: 12 });
    expect(r2Fetch).toHaveBeenCalledTimes(2);

    const pinned = await getProjectStats(
      new URL("https://replay.test/api/v1/projects/project_1/stats?warehouse_version=13"),
      env,
      ctx.value,
      "project_1",
      "request_4",
      startWideEvent("test", "stats"),
    );
    expect(pinned.status).toBe(503);
    expect(await pinned.json()).toEqual({ error: "analytics_unavailable" });

    state.privacyVersion = 13;
    const afterDeletion = await getProjectStats(
      new URL("https://replay.test/api/v1/projects/project_1/stats"),
      env,
      ctx.value,
      "project_1",
      "request_5",
      startWideEvent("test", "stats"),
    );
    expect(afterDeletion.status).toBe(503);
    expect(await afterDeletion.json()).toEqual({ error: "analytics_unavailable" });
  });

  it("uses prior unpinned session pages but isolates pins, deletion, privacy, and project", async () => {
    const cache = installCache();
    vi.spyOn(Date, "now").mockReturnValue(100_001_000);
    const state = warehouseState();
    const env = warehouseEnv(state);
    const ctx = testContext();
    let r2IsDown = false;
    const r2Fetch = vi.fn(async () => {
      if (r2IsDown) throw new Error("R2 SQL is unavailable");
      return r2SqlResponse([sessionRow("project_1")]);
    });
    vi.stubGlobal("fetch", r2Fetch);

    const requestUrl = new URL("https://replay.test/api/v1/projects/project_1/sessions");
    const fresh = await listSessions(
      requestUrl,
      env,
      "project_1",
      "bearer",
      startWideEvent("test", "sessions"),
      ctx.value,
    );
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({
      analyticsState: "fresh",
      warehouseVersion: 12,
      sessions: [{ project_id: "project_1", session_id: "session_1" }],
    });
    await ctx.finish();

    r2IsDown = true;
    const cacheRequests = sessionCacheRequests(
      "project_1",
      {
        ...withDefaultAnalyticsDateRange({}, Date.now()),
        limit: 50,
        sort: "newest",
        warehouse_version: 12,
      },
      0,
      false,
    );
    const current = await listSessions(
      requestUrl,
      env,
      "project_1",
      "bearer",
      startWideEvent("test", "sessions"),
      ctx.value,
    );
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ analyticsState: "fresh", warehouseVersion: 12 });
    expect(r2Fetch).toHaveBeenCalledTimes(1);

    state.verifiedSequence = 13;
    const stale = await listSessions(
      requestUrl,
      env,
      "project_1",
      "bearer",
      startWideEvent("test", "sessions"),
      ctx.value,
    );
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ analyticsState: "stale", warehouseVersion: 12 });

    const pinned = await listSessions(
      new URL("https://replay.test/api/v1/projects/project_1/sessions?warehouse_version=13"),
      env,
      "project_1",
      "bearer",
      startWideEvent("test", "sessions"),
      ctx.value,
    );
    expect(pinned.status).toBe(503);
    expect(await pinned.json()).toEqual({ error: "analytics_unavailable" });

    cache.saved.set(
      cacheRequests.lastGood.url,
      Response.json({
        cacheFormat: 1,
        warehouseVersion: 12,
        value: { sessions: [sessionRow("project_2")], nextBefore: null },
      }),
    );
    const wrongProject = await listSessions(
      requestUrl,
      env,
      "project_1",
      "bearer",
      startWideEvent("test", "sessions"),
      ctx.value,
    );
    expect(wrongProject.status).toBe(503);
    expect(await wrongProject.json()).toEqual({ error: "analytics_unavailable" });

    state.pendingDeletion = true;
    const deletionPending = await listSessions(
      requestUrl,
      env,
      "project_1",
      "bearer",
      startWideEvent("test", "sessions"),
      ctx.value,
    );
    expect(deletionPending.status).toBe(503);
    expect(await deletionPending.json()).toEqual({ error: "analytics_deletion_pending" });

    state.pendingDeletion = false;
    state.privacyVersion = 13;
    const afterDeletion = await listSessions(
      requestUrl,
      env,
      "project_1",
      "bearer",
      startWideEvent("test", "sessions"),
      ctx.value,
    );
    expect(afterDeletion.status).toBe(503);
    expect(await afterDeletion.json()).toEqual({ error: "analytics_unavailable" });
  });
});

function testRequests(): AnalyticsCacheRequests {
  return {
    current: new Request("https://cache.test/current"),
    lastGood: new Request("https://cache.test/last-good"),
  };
}

function installCache(): { saved: Map<string, Response> } {
  const saved = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      async match(request: Request): Promise<Response | undefined> {
        return saved.get(request.url)?.clone();
      },
      async put(request: Request, response: Response): Promise<void> {
        saved.set(request.url, response.clone());
      },
    },
  });
  return { saved };
}

interface WarehouseState {
  pendingDeletion: boolean;
  privacyVersion: number;
  verifiedSequence: number;
}

function warehouseState(): WarehouseState {
  return { pendingDeletion: false, privacyVersion: 0, verifiedSequence: 12 };
}

function warehouseEnv(state: WarehouseState): Env {
  return {
    ANALYTICS_EXPORT_ENABLED: "1",
    ANALYTICS_READ_BACKEND: "r2_sql",
    ANALYTICS_STREAM: { async send() {} },
    R2_SQL_ACCOUNT_ID: "account_1",
    R2_SQL_BUCKET: "analytics_bucket",
    R2_SQL_TOKEN: "reader_token",
    IDX_00: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("FROM projects")) return { jurisdiction: null };
                if (sql.includes("MAX(j.deletion_export_sequence)")) {
                  return { privacy_version: state.privacyVersion };
                }
                if (sql.includes("analytics_deletion_jobs")) {
                  return state.pendingDeletion ? { present: 1 } : null;
                }
                if (sql.includes("quarantined_at IS NOT NULL")) return null;
                if (sql.includes("analytics_backfill_completions")) {
                  return {
                    completed_at: 1,
                    required_sequence: 0,
                    report_id: "report_1",
                    source_session_count: 1,
                  };
                }
                if (sql.includes("analytics_warehouse_state")) {
                  return { verified_sequence: state.verifiedSequence };
                }
                throw new Error("The analytics cache test received an unknown D1 query");
              },
            };
          },
        };
      },
    } as unknown as Env["IDX_00"],
    PRESENCE: {
      getByName() {
        return {
          async fetch() {
            return Response.json({ sessions: [] });
          },
        };
      },
    } as unknown as Env["PRESENCE"],
  } as unknown as Env;
}

function testContext(): {
  value: Parameters<typeof getProjectStats>[2];
  finish(): Promise<void>;
} {
  const waits: Promise<unknown>[] = [];
  return {
    value: {
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise);
      },
    } as Parameters<typeof getProjectStats>[2],
    async finish() {
      await Promise.all(waits.splice(0));
    },
  };
}

function r2SqlResponse(rows: Record<string, unknown>[]): Response {
  return Response.json({
    success: true,
    result: {
      rows,
      schema: [],
      metrics: { bytes_scanned: 100, files_scanned: 1 },
    },
  });
}

function statsRow(projectId: string): Record<string, unknown> {
  return {
    project_id: projectId,
    row_kind: "aggregate",
    group_name: null,
    label: null,
    session_count: 5,
    event_count: null,
    affected_sessions: null,
    average_duration_ms: 1_200,
    p50_duration_ms: 900,
    total_clicks: 20,
    included_sessions: 4,
    total_pages: 8,
    insight_sessions: 4,
    rage_sessions: 2,
    quick_back_sessions: 1,
    average_interaction_time_ms: 700,
    average_max_scroll_depth: 80,
  };
}

function sessionRow(projectId: string): Record<string, unknown> {
  return {
    session_id: "session_1",
    project_id: projectId,
    org_id: "org_1",
    started_at: 1_000,
    ended_at: 2_000,
    duration_ms: 1_000,
    country: "US",
    region: "CA",
    city: "San Francisco",
    device: "desktop",
    browser: "Brave",
    os: "macOS",
    entry_url: "/pricing",
    url_count: 1,
    page_count: 1,
    analytics_version: 2,
    max_scroll_depth: 80,
    quick_backs: 0,
    interaction_time_ms: 700,
    activity_hist: null,
    clicks: 2,
    errors: 0,
    rages: 0,
    navs: 1,
    bytes: 500,
    segment_count: 1,
    flags: 0,
    manifest_key: "p/project_1/session_1/manifest.json",
    expires_at: 5_000,
  };
}
