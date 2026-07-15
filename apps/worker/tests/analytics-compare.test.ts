import {
  listSessionsResponseSchema,
  projectStatsResponseSchema,
  startWideEvent,
} from "@orange-replay/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  sameStatsWithoutErrors,
  sameSessionPage,
  warehouseIncludesD1Errors,
} from "../src/analytics/finalized-read.ts";
import { getProjectStats } from "../src/api/project-routes.ts";
import { listSessions } from "../src/api/session-routes.ts";
import { readStatsRows } from "../src/analytics/warehouse-read.ts";
import {
  ANALYTICS_COMPARE_QUERY_TIMEOUT_MS,
  canCompareD1Exactly,
} from "../src/analytics/compare.ts";
import type { Env } from "../src/env.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("analytics compare proof", () => {
  it("does not call sparse D1 error evidence an exact mismatch", () => {
    expect(canCompareD1Exactly({})).toBe(true);
    expect(canCompareD1Exactly({ error_detail: "Checkout failed" })).toBe(false);
  });

  it("allows tiny engine rounding differences but keeps counts exact", () => {
    const d1 = stats();
    const warehouse = structuredClone(d1);
    warehouse.duration.average.value += 0.000_000_1;
    warehouse.pagesPerSession.value = (warehouse.pagesPerSession.value ?? 0) + 0.000_000_1;

    expect(sameStatsWithoutErrors(d1, warehouse)).toBe(true);

    warehouse.sessions.value += 1;
    expect(sameStatsWithoutErrors(d1, warehouse)).toBe(false);
  });

  it("checks sparse error labels without depending on warehouse top-five order", () => {
    const d1 = stats();
    d1.errors = [
      {
        detail: "Checkout failed",
        filter: { error_detail: "Checkout failed" },
        count: { value: 2, filter: { error_detail: "Checkout failed" } },
        affectedSessions: { value: 1, filter: { error_detail: "Checkout failed" } },
      },
    ];

    expect(
      warehouseIncludesD1Errors(
        d1,
        new Map([["Checkout failed", { count: 4, affectedSessions: 2 }]]),
      ),
    ).toBe(true);
    expect(warehouseIncludesD1Errors(d1, new Map())).toBe(false);
  });

  it("compares the D1 session page without warehouse-only response fields", () => {
    const page = {
      sessions: [
        {
          session_id: "session_1",
          project_id: "project_1",
          started_at: 100,
        },
      ],
      nextBefore: null,
    };

    expect(
      sameSessionPage(
        page as never,
        {
          ...page,
          warehouseVersion: 12,
          metrics: { bytesScanned: 1, filesScanned: 1 },
        } as never,
      ),
    ).toBe(true);

    expect(
      sameSessionPage(
        page as never,
        {
          sessions: [{ ...page.sessions[0], session_id: "session_2" }],
          nextBefore: null,
        } as never,
      ),
    ).toBe(false);
  });
});

describe("analytics compare routes", () => {
  it("pins both stats reads and returns D1 before a delayed warehouse answer", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_001_000);
    const queries: D1Query[] = [];
    const env = compareEnv(queries);
    const ctx = testContext();
    const warehouseAnswer = deferred<Response>();
    let r2Query = "";
    const fetchR2 = vi.fn(async (_url: string, init: RequestInit) => {
      r2Query = readR2Query(init);
      return warehouseAnswer.promise;
    });
    vi.stubGlobal("fetch", fetchR2);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const responsePromise = getProjectStats(
      new URL("https://replay.test/api/v1/projects/project_1/stats"),
      env,
      ctx.value,
      "project_1",
      "request_stats",
      startWideEvent("test", "stats"),
    );
    let response: Response;
    try {
      response = await settledResponse(responsePromise);
    } finally {
      warehouseAnswer.resolve(r2SqlResponse([statsRow("project_1")]));
    }

    expect(response.status).toBe(200);
    expect(projectStatsResponseSchema.parse(await response.json())).toMatchObject({
      analyticsState: "compare",
      warehouseVersion: 12,
      sessions: { filter: { warehouse_version: 12 } },
    });
    expect(fetchR2).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), ANALYTICS_COMPARE_QUERY_TIMEOUT_MS);
    expect(r2Query).toContain("s.export_sequence <= 12");
    const d1StatsQuery = queries.find((query) => query.sql.includes("COUNT(*) AS session_count"));
    expect(d1StatsQuery?.sql).toContain("a.export_sequence <= ?");
    expect(d1StatsQuery?.bindings).toContain(12);

    await ctx.finish();
    expect(readCompareLog(log.mock.calls, "project_stats")).toMatchObject({
      analytics_compare_status: "match",
      outcome: "success",
      request_id: "request_stats",
      warehouse_version: 12,
    });
  });

  it("pins both session reads and returns D1 before a delayed warehouse failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_001_000);
    const queries: D1Query[] = [];
    const env = compareEnv(queries);
    const ctx = testContext();
    const warehouseAnswer = deferred<Response>();
    let r2Query = "";
    const fetchR2 = vi.fn(async (_url: string, init: RequestInit) => {
      r2Query = readR2Query(init);
      return warehouseAnswer.promise;
    });
    vi.stubGlobal("fetch", fetchR2);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const responsePromise = listSessions(
      new URL("https://replay.test/api/v1/projects/project_1/sessions"),
      env,
      "project_1",
      "session",
      "request_sessions",
      startWideEvent("test", "sessions"),
      ctx.value,
    );
    let response: Response;
    try {
      response = await settledResponse(responsePromise);
    } finally {
      warehouseAnswer.reject(new Error("R2 SQL test delay ended with a failure"));
    }

    expect(response.status).toBe(200);
    expect(listSessionsResponseSchema.parse(await response.json())).toMatchObject({
      analyticsState: "compare",
      warehouseVersion: 12,
      sessions: [{ project_id: "project_1", session_id: "session_1" }],
    });
    expect(fetchR2).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), ANALYTICS_COMPARE_QUERY_TIMEOUT_MS);
    expect(r2Query).toContain("s.export_sequence <= 12");
    const d1SessionsQuery = queries.find((query) =>
      query.sql.startsWith("SELECT session_id, project_id"),
    );
    expect(d1SessionsQuery?.sql).toContain("a.export_sequence <= ?");
    expect(d1SessionsQuery?.bindings).toContain(12);

    await ctx.finish();
    expect(readCompareLog(errorLog.mock.calls, "sessions_list")).toMatchObject({
      analytics_compare_status: "unavailable",
      outcome: "server_error",
      request_id: "request_sessions",
      warehouse_version: 12,
    });
  });

  it("returns an invalid warehouse version error before reading stats from D1", async () => {
    const queries: D1Query[] = [];
    const env = compareEnv(queries);
    const ctx = testContext();
    const fetchR2 = vi.fn();
    vi.stubGlobal("fetch", fetchR2);

    const response = await getProjectStats(
      new URL("https://replay.test/api/v1/projects/project_1/stats?warehouse_version=13"),
      env,
      ctx.value,
      "project_1",
      "request_invalid_stats",
      startWideEvent("test", "stats"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_warehouse_version" });
    expect(fetchR2).not.toHaveBeenCalled();
    expect(queries.some((query) => query.sql.includes("COUNT(*) AS session_count"))).toBe(false);
  });

  it("returns an invalid warehouse version error before reading sessions from D1", async () => {
    const queries: D1Query[] = [];
    const env = compareEnv(queries);
    const ctx = testContext();
    const fetchR2 = vi.fn();
    vi.stubGlobal("fetch", fetchR2);

    const response = await listSessions(
      new URL("https://replay.test/api/v1/projects/project_1/sessions?warehouse_version=13"),
      env,
      "project_1",
      "session",
      "request_invalid_sessions",
      startWideEvent("test", "sessions"),
      ctx.value,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_warehouse_version" });
    expect(fetchR2).not.toHaveBeenCalled();
    expect(queries.some((query) => query.sql.startsWith("SELECT session_id, project_id"))).toBe(
      false,
    );
  });

  it("serves D1 but reports an unavailable snapshot as a failed compare", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_001_000);
    const queries: D1Query[] = [];
    const env = compareEnv(queries, { warehouseReady: false });
    const statsCtx = testContext();
    const sessionsCtx = testContext();
    const fetchR2 = vi.fn();
    vi.stubGlobal("fetch", fetchR2);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const [statsResponse, sessionsResponse] = await Promise.all([
      getProjectStats(
        new URL("https://replay.test/api/v1/projects/project_1/stats"),
        env,
        statsCtx.value,
        "project_1",
        "request_stats_unavailable",
        startWideEvent("test", "stats"),
      ),
      listSessions(
        new URL("https://replay.test/api/v1/projects/project_1/sessions"),
        env,
        "project_1",
        "session",
        "request_sessions_unavailable",
        startWideEvent("test", "sessions"),
        sessionsCtx.value,
      ),
    ]);

    expect(statsResponse.status).toBe(200);
    expect(sessionsResponse.status).toBe(200);
    const statsBody = projectStatsResponseSchema.parse(await statsResponse.json());
    const sessionsBody = listSessionsResponseSchema.parse(await sessionsResponse.json());
    expect(statsBody).toMatchObject({ analyticsState: "compare" });
    expect(sessionsBody).toMatchObject({ analyticsState: "compare" });
    expect(statsBody).not.toHaveProperty("warehouseVersion");
    expect(sessionsBody).not.toHaveProperty("warehouseVersion");
    expect(fetchR2).not.toHaveBeenCalled();

    await Promise.all([statsCtx.finish(), sessionsCtx.finish()]);
    expect(readCompareLog(errorLog.mock.calls, "project_stats")).toMatchObject({
      analytics_compare_error: "analytics_backfill_pending",
      analytics_compare_status: "unavailable",
      outcome: "server_error",
      request_id: "request_stats_unavailable",
    });
    expect(readCompareLog(errorLog.mock.calls, "sessions_list")).toMatchObject({
      analytics_compare_error: "analytics_backfill_pending",
      analytics_compare_status: "unavailable",
      outcome: "server_error",
      request_id: "request_sessions_unavailable",
    });
  });

  it("uses the short timeout for both stats comparison queries", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_001_000);
    const queries: D1Query[] = [];
    const env = compareEnv(queries, { includeD1Error: true });
    const ctx = testContext();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const fetchR2 = vi.fn(async (_url: string, init: RequestInit) => {
      const query = readR2Query(init);
      return query.includes("stats_rows AS")
        ? r2SqlResponse([statsRow("project_1")])
        : r2SqlResponse([
            {
              project_id: "project_1",
              label: "Checkout failed",
              event_count: 2,
              affected_sessions: 1,
            },
          ]);
    });
    vi.stubGlobal("fetch", fetchR2);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await getProjectStats(
      new URL("https://replay.test/api/v1/projects/project_1/stats"),
      env,
      ctx.value,
      "project_1",
      "request_stats_evidence",
      startWideEvent("test", "stats"),
    );
    expect(response.status).toBe(200);
    await ctx.finish();

    expect(fetchR2).toHaveBeenCalledTimes(2);
    expect(
      timeout.mock.calls.filter(([, delay]) => delay === ANALYTICS_COMPARE_QUERY_TIMEOUT_MS),
    ).toHaveLength(2);
    expect(readCompareLog(log.mock.calls, "project_stats")).toMatchObject({
      analytics_compare_status: "match",
      outcome: "success",
      request_id: "request_stats_evidence",
    });
  });
});

function stats() {
  return readStatsRows(
    [
      {
        project_id: "project_1",
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
      },
    ],
    {},
  );
}

interface D1Query {
  bindings: unknown[];
  sql: string;
}

interface CompareEnvOptions {
  includeD1Error?: boolean;
  warehouseReady?: boolean;
}

function compareEnv(queries: D1Query[], options: CompareEnvOptions = {}): Env {
  const database = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          queries.push({ bindings, sql });
          return {
            async all<Row>() {
              let rows: Record<string, unknown>[] = [];
              if (sql.startsWith("SELECT session_id, project_id")) {
                rows = [sessionRow("project_1")];
              } else if (options.includeD1Error && sql.includes("FROM session_events e")) {
                rows = [
                  {
                    detail: "Checkout failed",
                    event_count: 2,
                    affected_sessions: 1,
                  },
                ];
              }
              return { results: rows as Row[] };
            },
            async first<Row>() {
              return firstD1Row(sql, options) as Row | null;
            },
          };
        },
      };
    },
  } as Env["IDX_00"];

  return {
    ANALYTICS_EXPORT_ENABLED: "1",
    ANALYTICS_READ_BACKEND: "compare",
    ANALYTICS_STREAM: { async send() {} } as Env["ANALYTICS_STREAM"],
    R2_SQL_ACCOUNT_ID: "account_1",
    R2_SQL_BUCKET: "analytics_bucket",
    R2_SQL_TOKEN: "reader_token",
    IDX_00: database,
    PRESENCE: {
      getByName() {
        return {
          async fetch() {
            return Response.json({ sessions: [] });
          },
        };
      },
    } as Env["PRESENCE"],
  } as Env;
}

function firstD1Row(sql: string, options: CompareEnvOptions): Record<string, unknown> | null {
  if (sql.includes("FROM projects")) return { jurisdiction: null };
  if (sql.includes("MAX(j.deletion_export_sequence)")) return { privacy_version: 0 };
  if (sql.includes("analytics_deletion_jobs")) return null;
  if (sql.includes("quarantined_at IS NOT NULL")) return null;
  if (sql.includes("analytics_backfill_completions")) {
    if (options.warehouseReady === false) return null;
    return {
      completed_at: 1,
      required_sequence: 0,
      report_id: "report_1",
      source_session_count: 1,
    };
  }
  if (sql.includes("analytics_warehouse_state")) return { verified_sequence: 12 };
  if (sql.includes("AVG(duration_ms) AS p50_duration_ms")) return { p50_duration_ms: 900 };
  if (sql.includes("COUNT(*) AS session_count")) return statsRow("project_1");
  throw new Error("The compare route test received an unknown D1 query");
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

interface Deferred<Value> {
  promise: Promise<Value>;
  reject(error: unknown): void;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

async function settledResponse(responsePromise: Promise<Response>): Promise<Response> {
  let response: Response | undefined;
  let routeError: unknown;
  void responsePromise.then(
    (value) => {
      response = value;
    },
    (error: unknown) => {
      routeError = error;
    },
  );

  for (let turn = 0; turn < 100 && response === undefined && routeError === undefined; turn += 1) {
    await Promise.resolve();
  }
  if (routeError !== undefined) throw routeError;
  if (response === undefined) {
    throw new Error("The D1 compare response waited for the warehouse shadow read");
  }
  return response;
}

function readR2Query(init: RequestInit): string {
  if (typeof init.body !== "string") throw new Error("Expected an R2 SQL request body");
  const body = JSON.parse(init.body) as { query?: unknown };
  if (typeof body.query !== "string") throw new Error("Expected an R2 SQL query");
  return body.query;
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

function readCompareLog(
  calls: readonly unknown[][],
  route: "project_stats" | "sessions_list",
): Record<string, unknown> {
  for (const call of calls) {
    const line = call[0];
    if (typeof line !== "string") continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event["event"] === "analytics.compare" && event["analytics_compare_route"] === route) {
      return event;
    }
  }
  throw new Error(`No analytics compare event was written for ${route}`);
}
