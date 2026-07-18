import { describe, expect, it } from "vite-plus/test";
import type { SessionFilter } from "@orange-replay/shared";
import type { SessionListOptions } from "../src/query/session-query.ts";
import {
  AnalyticsReadError,
  runR2SqlProjectQuery,
  type R2SqlSettings,
} from "../src/analytics/r2-sql-client.ts";
import { sqlAllowedName, sqlText, sqlWholeNumber } from "../src/analytics/sql.ts";
import {
  buildWarehouseErrorEvidenceQuery,
  buildWarehouseSessionsQuery,
  buildWarehouseStatsQuery,
} from "../src/analytics/warehouse-query.ts";
import { readStatsRows } from "../src/analytics/warehouse-read.ts";

const settings: R2SqlSettings = {
  accountId: "account/id",
  bucketName: "analytics bucket",
  token: "secret-token",
  timeoutMs: 100,
  serviceUrl: "https://sql.example.test/",
};

describe("analytics SQL safety", () => {
  it("keeps quote characters inside one text value", () => {
    expect(sqlText("x'; DROP TABLE analytics_sessions; --")).toBe(
      "'x''; DROP TABLE analytics_sessions; --'",
    );
    expect(sqlText("O'Reilly")).toBe("'O''Reilly'");
  });

  it("accepts only exact names and exact whole numbers", () => {
    expect(sqlAllowedName("country", ["country", "browser"] as const, "column")).toBe('"country"');
    expect(() => sqlAllowedName("country DESC", ["country", "browser"] as const, "column")).toThrow(
      "Unknown analytics column",
    );
    expect(sqlWholeNumber(42, "Version")).toBe("42");
    expect(() => sqlWholeNumber(-1, "Version")).toThrow("Version must be a whole number");
    expect(() => sqlWholeNumber(1.5, "Version")).toThrow("Version must be a whole number");
  });
});

describe("analytics warehouse queries", () => {
  it("scopes, versions, deduplicates, and removes deleted sessions", () => {
    const query = buildWarehouseStatsQuery("project_1", 73, { from: 100, to: 200 });

    // Session and event rows use the doorway snapshot. Deletions are always
    // applied so an old link cannot resurrect erased data.
    expect(count(query.sql, "export_sequence <= 73")).toBe(2);
    expect(query.sql).toContain("PARTITION BY s.project_id, s.export_id");
    expect(query.sql).toContain("PARTITION BY e.project_id, e.export_id");
    expect(query.sql).toContain("PARTITION BY d.project_id, d.export_id");
    // R2 SQL incorrectly removes every left row when an empty Iceberg table
    // has a non-null join column and the anti-join checks that column for NULL.
    expect(query.sql).toContain("NOT EXISTS");
    expect(query.sql).toContain("FROM deleted_sessions d");
    expect(query.sql).not.toContain("LEFT JOIN deleted_sessions d");
    expect(count(query.sql, "project_id = 'project_1'")).toBeGreaterThanOrEqual(4);
    expect(count(query.sql, '"analytics_sessions"')).toBe(1);
    expect(count(query.sql, '"analytics_events"')).toBe(1);
    expect(count(query.sql, '"analytics_deletions"')).toBe(1);
    expect(query.sql).not.toContain("session_started_at");
    expect(query.sql).not.toContain("analytics_deletions_v2");
    // Pipeline sink SQL is the required-field gate. Repeating every null
    // check here makes live R2 SQL exceed its expression-depth limit.
    expect(query.sql).not.toContain("s.org_id IS NOT NULL");
    expect(query.sql).not.toContain("e.event_index IS NOT NULL");
    expect(query.sql).not.toContain("d.deleted_at IS NOT NULL");
    expect(query.sql).toContain("MEDIAN(s.duration_ms)");
    expect(query.sql).toContain("UNION ALL");
    expect(query.sql).not.toContain(";");
  });

  it("uses the date-pruned v2 table only when the caller selects it", () => {
    const query = buildWarehouseStatsQuery("project_1", 73, { from: 100, to: 200 }, "v2");

    expect(query.sql).toContain('FROM "default"."analytics_deletions_v2" d');
    expect(query.sql).not.toContain('FROM "default"."analytics_deletions" d');
    expect(query.sql).toContain("(d.session_started_at IS NULL OR d.session_started_at >= 100)");
    expect(query.sql).toContain("(d.session_started_at IS NULL OR d.session_started_at <= 200)");
    expect(query.sql).toContain("ORDER BY d.export_sequence DESC, d.recorded_at DESC");
    expect(query.sql).not.toContain("d.export_sequence <= 73");
  });

  it("compiles all filters and quote-heavy text without changing SQL structure", () => {
    const filter: SessionFilter = {
      from: 100,
      to: 200,
      country: "U'S",
      region: "CA",
      city: "San Francisco",
      device: "desktop",
      browser: "Brave",
      os: "macOS",
      entry_url: "/checkout",
      entry_url_prefix: "/shop/50%_' OR 1=1 --",
      has_errors: true,
      error_detail: "Can't pay",
      has_page_coverage: true,
      has_rage: false,
      has_quick_back: true,
      has_insights: true,
      min_duration_ms: 500,
    };
    const query = buildWarehouseStatsQuery("project_' OR 1=1 --", 7, filter).sql;

    expect(query).toContain("s.project_id = 'project_'' OR 1=1 --'");
    expect(query).not.toContain("s.project_id = 'project_' OR 1=1 --'");
    expect(query).toContain("s.\"country\" = 'U''S'");
    expect(query).toContain("s.\"city\" = 'San Francisco'");
    expect(query).toContain("substr(s.entry_url, 1, length('/shop/50%_'' OR 1=1 --'))");
    expect(query).toContain("COALESCE(e.event_detail, 'Unknown error') = 'Can''t pay'");
    expect(query).toContain("s.rages = 0");
    expect(query).toContain("s.quick_backs >= 1");
  });

  it("uses the same keyset rules as the current sessions API", () => {
    const options: SessionListOptions = {
      from: 100,
      to: 200,
      limit: 25,
      sort: "friction",
      before: { sort: "friction", sortValue: 1_203, sessionId: "session_b" },
      error_detail: "Checkout failed",
    };
    const query = buildWarehouseSessionsQuery("project_1", 9, options).sql;

    expect(query).toContain('FROM "default"."analytics_events" e');
    expect(query).toContain("INNER JOIN live_sessions target_session");
    expect(query).toContain("AND e.event_kind = 'error'");
    expect(query).toContain(
      "((s.errors * 1000 + s.rages * 100 + s.clicks) < 1203 OR ((s.errors * 1000 + s.rages * 100 + s.clicks) = 1203 AND s.session_id < 'session_b'))",
    );
    expect(query).toContain(
      "ORDER BY (s.errors * 1000 + s.rages * 100 + s.clicks) DESC, s.session_id DESC",
    );
    expect(query).toContain("LIMIT 25");
  });

  it("renders every R2 sort and cursor shape from the shared semantics", () => {
    const cases: {
      options: SessionListOptions;
      cursorSql: string;
      orderSql: string;
    }[] = [
      {
        options: {
          from: 100,
          limit: 25,
          sort: "newest",
          before: { sort: "newest", sortValue: 3_000 },
        },
        cursorSql: "s.started_at < 3000",
        orderSql: "s.started_at DESC, s.session_id DESC",
      },
      {
        options: {
          from: 100,
          limit: 25,
          sort: "newest",
          before: { sort: "newest", sortValue: 3_000, sessionId: "session_b" },
        },
        cursorSql: "(s.started_at < 3000 OR (s.started_at = 3000 AND s.session_id < 'session_b'))",
        orderSql: "s.started_at DESC, s.session_id DESC",
      },
      {
        options: {
          from: 100,
          limit: 25,
          sort: "friction",
          before: { sort: "friction", sortValue: 1_203, sessionId: "session_b" },
        },
        cursorSql:
          "((s.errors * 1000 + s.rages * 100 + s.clicks) < 1203 OR ((s.errors * 1000 + s.rages * 100 + s.clicks) = 1203 AND s.session_id < 'session_b'))",
        orderSql: "(s.errors * 1000 + s.rages * 100 + s.clicks) DESC, s.session_id DESC",
      },
      {
        options: {
          from: 100,
          limit: 25,
          sort: "duration",
          before: { sort: "duration", sortValue: 2_500, sessionId: "session_b" },
        },
        cursorSql:
          "(s.duration_ms < 2500 OR (s.duration_ms = 2500 AND s.session_id < 'session_b'))",
        orderSql: "s.duration_ms DESC, s.session_id DESC",
      },
      {
        options: {
          from: 100,
          limit: 25,
          sort: "clicks",
          before: { sort: "clicks", sortValue: 3, sessionId: "session_b" },
        },
        cursorSql: "(s.clicks < 3 OR (s.clicks = 3 AND s.session_id < 'session_b'))",
        orderSql: "s.clicks DESC, s.session_id DESC",
      },
      {
        options: {
          from: 100,
          limit: 25,
          sort: "pages",
          before: { sort: "pages", sortValue: 2, sessionId: "session_b" },
        },
        cursorSql:
          "(s.page_count IS NULL OR s.page_count < 2 OR (s.page_count = 2 AND s.session_id < 'session_b'))",
        orderSql: "s.page_count IS NULL, s.page_count DESC, s.session_id DESC",
      },
      {
        options: {
          from: 100,
          limit: 25,
          sort: "pages",
          before: { sort: "pages", sortValue: null, sessionId: "session_b" },
        },
        cursorSql: "(s.page_count IS NULL AND s.session_id < 'session_b')",
        orderSql: "s.page_count IS NULL, s.page_count DESC, s.session_id DESC",
      },
    ];

    for (const testCase of cases) {
      const query = buildWarehouseSessionsQuery("project_1", 9, testCase.options).sql;
      expect(query).toContain(`WHERE ${testCase.cursorSql}`);
      expect(query).toContain(`ORDER BY ${testCase.orderSql}`);
    }
  });

  it("keeps false filters flat and skips event rows when no error detail is requested", () => {
    const query = buildWarehouseSessionsQuery("project_1", 9, {
      from: 100,
      to: 200,
      limit: 25,
      sort: "newest",
      city: "Toronto",
      has_errors: false,
      has_page_coverage: false,
      has_rage: false,
      has_quick_back: false,
      has_insights: false,
    }).sql;

    expect(query).toContain("s.\"city\" = 'Toronto'");
    expect(query).toContain("s.errors = 0");
    expect(query).toContain("(s.analytics_version < 1 OR s.page_count IS NULL)");
    expect(query).toContain("s.analytics_version >= 2 AND s.rages = 0");
    expect(query).toContain("s.analytics_version >= 2 AND s.quick_backs = 0");
    expect(query).toContain("s.analytics_version < 2");
    expect(query).not.toContain("analytics_events");
    expect(query).not.toContain("s.org_id IS NOT NULL");
  });

  it("does not scan events for a sessions page that does not need them", () => {
    const query = buildWarehouseSessionsQuery("project_1", 9, {
      from: 100,
      to: 200,
      limit: 50,
      sort: "newest",
    }).sql;

    expect(query).not.toContain("analytics_events");
  });

  it("filters only the newest correction for each session", () => {
    const query = buildWarehouseSessionsQuery("project_1", 9, {
      from: 100,
      limit: 50,
      min_duration_ms: 1_000,
      sort: "duration",
    }).sql;
    const newestSession = query.indexOf("WHERE s.session_rank = 1");
    const durationFilter = query.indexOf("s.duration_ms >= 1000");

    expect(newestSession).toBeGreaterThan(-1);
    expect(durationFilter).toBeGreaterThan(newestSession);
  });

  it("queries each sparse D1 error label directly instead of trusting the top five", () => {
    const query = buildWarehouseErrorEvidenceQuery(
      "project_1",
      9,
      { from: 100, to: 200, country: "US" },
      ["O'Reilly failed", "Unknown error"],
    ).sql;

    expect(query).toContain("IN ('O''Reilly failed', 'Unknown error')");
    expect(query).toContain("COUNT(DISTINCT e.session_id) AS affected_sessions");
    expect(query).not.toContain("error_rank <= 5");
  });

  it("rejects a made-up sort, cursor mismatch, unsafe version, and large page", () => {
    expect(() =>
      buildWarehouseSessionsQuery("project_1", 1, {
        limit: 10,
        sort: "started_at DESC" as never,
      }),
    ).toThrow("Unknown analytics session sort");
    expect(() =>
      buildWarehouseSessionsQuery("project_1", 1, {
        limit: 10,
        sort: "newest",
        before: { sort: "clicks", sortValue: 3, sessionId: "session_b" },
      }),
    ).toThrow("Session cursor does not match its sort");
    expect(() =>
      buildWarehouseSessionsQuery("project_1", -1, { limit: 10, sort: "newest" }),
    ).toThrow("Warehouse version must be a whole number");
    expect(() =>
      buildWarehouseSessionsQuery("project_1", 1, { limit: 101, sort: "newest" }),
    ).toThrow("Session limit must be between 1 and 100");
  });

  it("refuses an unbounded dashboard query", () => {
    expect(() => buildWarehouseStatsQuery("project_1", 1, {})).toThrow(
      "Analytics date range is required",
    );
    expect(() =>
      buildWarehouseSessionsQuery("project_1", 1, { limit: 25, sort: "newest" }),
    ).toThrow("Analytics date range is required");
  });
});

describe("R2 SQL client", () => {
  it("sends the documented request and accepts only the requested project", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const result = await runR2SqlProjectQuery<{ project_id: string; session_count: number }>(
      settings,
      "project_1",
      "SELECT 'project_1' AS project_id, 2 AS session_count",
      async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return jsonResponse({
          success: true,
          result: {
            schema: [{ name: "project_id", type: "Utf8" }],
            rows: [{ project_id: "project_1", session_count: 2 }],
            metrics: { bytes_scanned: 10_485_760, files_scanned: 3 },
          },
        });
      },
    );

    expect(requestUrl).toBe(
      "https://sql.example.test/api/v1/accounts/account%2Fid/r2-sql/query/analytics%20bucket",
    );
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer secret-token");
    const requestBody = requestInit?.body;
    if (typeof requestBody !== "string") throw new Error("Expected a JSON request body");
    expect(JSON.parse(requestBody)).toEqual({
      query: "SELECT 'project_1' AS project_id, 2 AS session_count",
    });
    expect(result).toEqual({
      rows: [{ project_id: "project_1", session_count: 2 }],
      metrics: { bytesScanned: 10_485_760, filesScanned: 3 },
    });
  });

  it("gives clear errors for auth, rate, service, query timeout, and bad output", async () => {
    const cases = [
      {
        response: () => jsonResponse({}, 401),
        kind: "analytics_login_failed",
        canRetry: false,
      },
      {
        response: () => jsonResponse({}, 403),
        kind: "analytics_access_denied",
        canRetry: false,
      },
      {
        response: () => jsonResponse({}, 429, { "retry-after": "7" }),
        kind: "analytics_busy",
        canRetry: true,
        retryAfterSeconds: 7,
      },
      {
        response: () => jsonResponse({}, 503),
        kind: "analytics_service_unavailable",
        canRetry: true,
      },
      {
        response: () => jsonResponse({ errors: [{ code: 80_001 }] }, 504),
        kind: "analytics_query_timed_out",
        canRetry: true,
      },
      {
        response: () => jsonResponse({ success: true, result: { rows: [] } }),
        kind: "analytics_response_invalid",
        canRetry: true,
      },
      {
        response: () =>
          jsonResponse({
            success: true,
            result: {
              schema: [],
              rows: [{ project_id: "project_2" }],
              metrics: { bytes_scanned: 0, files_scanned: 0 },
            },
          }),
        kind: "analytics_project_mismatch",
        canRetry: false,
      },
    ] as const;

    for (const testCase of cases) {
      try {
        await runR2SqlProjectQuery(settings, "project_1", "SELECT 1", async () =>
          testCase.response(),
        );
        throw new Error("Expected analytics read to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(AnalyticsReadError);
        expect(error).toMatchObject({
          kind: testCase.kind,
          canRetry: testCase.canRetry,
          ...(!("retryAfterSeconds" in testCase)
            ? {}
            : { retryAfterSeconds: testCase.retryAfterSeconds }),
        });
      }
    }
  });

  it("stops a request that does not answer", async () => {
    await expect(
      runR2SqlProjectQuery(
        { ...settings, timeoutMs: 1 },
        "project_1",
        "SELECT 1",
        async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    ).rejects.toMatchObject({ kind: "analytics_request_timed_out", canRetry: true });
  });

  it("stops a response body that does not finish", async () => {
    await expect(
      runR2SqlProjectQuery(
        { ...settings, timeoutMs: 1 },
        "project_1",
        "SELECT 1",
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener("abort", () => {
                  const error = new Error("aborted while reading the body");
                  error.name = "AbortError";
                  controller.error(error);
                });
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    ).rejects.toMatchObject({ kind: "analytics_request_timed_out", canRetry: true });
  });
});

describe("warehouse stats rows", () => {
  it("rebuilds dashboard stats and keeps every metric doorway filter", () => {
    const filter: SessionFilter = { from: 1_000, country: "US" };
    const stats = readStatsRows(
      [
        aggregateRow(),
        {
          project_id: "project_1",
          row_kind: "breakdown",
          group_name: "browser",
          label: "Brave",
          session_count: 3,
        },
        {
          project_id: "project_1",
          row_kind: "breakdown",
          group_name: "entry_page",
          label: "/pricing",
          session_count: 2,
        },
        {
          project_id: "project_1",
          row_kind: "breakdown",
          group_name: "city",
          label: "San Jose",
          dimension_country: "US",
          session_count: 2,
        },
        {
          project_id: "project_1",
          row_kind: "error",
          group_name: "error",
          label: "Checkout failed",
          event_count: 4,
          affected_sessions: 2,
        },
      ],
      filter,
    );

    expect(stats.sessions).toEqual({ value: 5, filter });
    expect(stats.duration.p50.value).toBe(900);
    expect(stats.pagesPerSession.value).toBe(2);
    expect(stats.pagesPerSession.filter).toEqual({ ...filter, has_page_coverage: true });
    expect(stats.insights.ragePercent).toEqual({
      value: 0.5,
      filter: { ...filter, has_rage: true },
    });
    expect(stats.breakdowns.browser[0]?.filter).toEqual({ ...filter, browser: "Brave" });
    expect(stats.breakdowns.entryPage[0]?.filter).toEqual({ ...filter, entry_url: "/pricing" });
    expect(stats.breakdowns.city[0]?.country).toBe("US");
    expect(stats.breakdowns.city[0]?.filter).toEqual({
      ...filter,
      country: "US",
      city: "San Jose",
    });
    expect(stats.errors[0]?.filter).toEqual({ ...filter, error_detail: "Checkout failed" });
  });

  it("rejects missing aggregates and unknown breakdown groups", () => {
    expect(() => readStatsRows([], {})).toThrow(AnalyticsReadError);
    expect(() =>
      readStatsRows(
        [
          aggregateRow(),
          {
            project_id: "project_1",
            row_kind: "breakdown",
            group_name: "raw_sql",
            label: "unsafe",
            session_count: 1,
          },
        ],
        {},
      ),
    ).toThrow(AnalyticsReadError);
  });
});

function aggregateRow(): Record<string, unknown> {
  return {
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
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function count(value: string, part: string): number {
  return value.split(part).length - 1;
}
