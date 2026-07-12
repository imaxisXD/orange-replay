import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildSessionsQuery,
  encodeSessionCursor,
  isValidPathId,
  isValidSegmentName,
  parseSessionListQuery,
} from "../src/api/helpers.ts";
import { handleApi } from "../src/api/handler.ts";
import {
  buildAggregateStatsQuery,
  buildBreakdownQuery,
  buildErrorGroupsQuery,
  buildMedianDurationQuery,
  countFilteredLiveSessions,
  parseStatsFilter,
  statsCacheRequest,
} from "../src/api/stats.ts";
import { isDevTestMode } from "../src/env.ts";
import type { Env } from "../src/env.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api helper decisions", () => {
  it("validates safe path ids", () => {
    expect(isValidPathId("project_123-ABC")).toBe(true);
    expect(isValidPathId("a".repeat(64))).toBe(true);
    expect(isValidPathId("")).toBe(false);
    expect(isValidPathId("a".repeat(65))).toBe(false);
    expect(isValidPathId("../project")).toBe(false);
    expect(isValidPathId("project%2fsecret")).toBe(false);
  });

  it("validates immutable segment names", () => {
    expect(isValidSegmentName("seg-000001.ors")).toBe(true);
    expect(isValidSegmentName("seg-1.ors")).toBe(false);
    expect(isValidSegmentName("../manifest.json")).toBe(false);
  });

  it("builds the sessions list query with filters and a capped limit", () => {
    const parsed = parseSessionListQuery(
      new URLSearchParams(
        "limit=250&before=4000&from=1000&to=3000&country=US&region=CA&device=desktop&browser=Chrome&os=macOS&entry_url=%2Fcheckout%2Fcomplete&entry_url_prefix=%2Fcheckout&has_errors=1&error_detail=Checkout+failed&has_page_coverage=1&has_rage=1&has_quick_back=1&has_insights=1&min_duration_ms=500",
      ),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const query = buildSessionsQuery("project_1", parsed.options);
    expect(query).toEqual({
      sql: "SELECT session_id, project_id, org_id, started_at, ended_at, duration_ms, country, region, city, device, browser, os, entry_url, url_count, page_count, analytics_version, max_scroll_depth, quick_backs, interaction_time_ms, activity_hist, clicks, errors, rages, navs, bytes, segment_count, flags, manifest_key, expires_at FROM sessions WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM session_deletions d WHERE d.project_id = sessions.project_id AND d.session_id = sessions.session_id) AND started_at < ? AND started_at >= ? AND started_at <= ? AND country = ? AND region = ? AND device = ? AND browser = ? AND os = ? AND entry_url = ? AND entry_url >= ? AND entry_url < ? AND errors >= ? AND EXISTS (SELECT 1 FROM session_events e WHERE e.project_id = sessions.project_id AND e.session_id = sessions.session_id AND e.kind = ? AND COALESCE(e.detail, ?) = ?) AND (analytics_version >= ? AND page_count IS NOT NULL) AND analytics_version >= ? AND rages >= ? AND analytics_version >= ? AND quick_backs >= ? AND analytics_version >= ? AND duration_ms >= ? ORDER BY started_at DESC, session_id DESC LIMIT ?",
      bindings: [
        "project_1",
        4000,
        1000,
        3000,
        "US",
        "CA",
        "desktop",
        "Chrome",
        "macOS",
        "/checkout/complete",
        "/checkout",
        "/checkouu",
        1,
        "error",
        "Unknown error",
        "Checkout failed",
        1,
        2,
        1,
        2,
        1,
        2,
        500,
        100,
      ],
    });
  });

  it("builds surrogate-safe and maximum-code-point URL prefix bounds", () => {
    const beforeSurrogates = `/path/${String.fromCodePoint(0xd7ff)}`;
    const safeRange = buildSessionsQuery("project_1", {
      limit: 10,
      sort: "newest",
      entry_url_prefix: beforeSurrogates,
    });
    expect(safeRange.bindings).toEqual([
      "project_1",
      beforeSurrogates,
      `/path/${String.fromCodePoint(0xe000)}`,
      10,
    ]);

    const maximumPrefix = String.fromCodePoint(0x10ffff);
    const exactFallback = buildSessionsQuery("project_1", {
      limit: 10,
      sort: "newest",
      entry_url_prefix: maximumPrefix,
    });
    expect(exactFallback.sql).toContain("substr(entry_url, 1, length(?)) = ?");
    expect(exactFallback.bindings).toEqual([
      "project_1",
      maximumPrefix,
      maximumPrefix,
      maximumPrefix,
      10,
    ]);
  });

  it("builds exact keyset SQL for every sessions sort", () => {
    const select =
      "SELECT session_id, project_id, org_id, started_at, ended_at, duration_ms, country, region, city, device, browser, os, entry_url, url_count, page_count, analytics_version, max_scroll_depth, quick_backs, interaction_time_ms, activity_hist, clicks, errors, rages, navs, bytes, segment_count, flags, manifest_key, expires_at FROM sessions WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM session_deletions d WHERE d.project_id = sessions.project_id AND d.session_id = sessions.session_id)";
    const cases = [
      {
        query: "sort=newest&before=3000:session_b&limit=10",
        sql: `${select} AND (started_at < ? OR (started_at = ? AND session_id < ?)) ORDER BY started_at DESC, session_id DESC LIMIT ?`,
        bindings: ["project_1", 3000, 3000, "session_b", 10],
      },
      {
        query: "sort=friction&before=friction:1102:session_b&limit=10",
        sql: `${select} AND ((errors * 1000 + rages * 100 + clicks) < ? OR ((errors * 1000 + rages * 100 + clicks) = ? AND session_id < ?)) ORDER BY (errors * 1000 + rages * 100 + clicks) DESC, session_id DESC LIMIT ?`,
        bindings: ["project_1", 1102, 1102, "session_b", 10],
      },
      {
        query: "sort=duration&before=duration:2500:session_b&limit=10",
        sql: `${select} AND (duration_ms < ? OR (duration_ms = ? AND session_id < ?)) ORDER BY duration_ms DESC, session_id DESC LIMIT ?`,
        bindings: ["project_1", 2500, 2500, "session_b", 10],
      },
      {
        query: "sort=clicks&before=clicks:3:session_b&limit=10",
        sql: `${select} AND (clicks < ? OR (clicks = ? AND session_id < ?)) ORDER BY clicks DESC, session_id DESC LIMIT ?`,
        bindings: ["project_1", 3, 3, "session_b", 10],
      },
      {
        query: "sort=pages&before=pages:2:session_b&limit=10",
        sql: `${select} AND (page_count IS NULL OR page_count < ? OR (page_count = ? AND session_id < ?)) ORDER BY page_count IS NULL, page_count DESC, session_id DESC LIMIT ?`,
        bindings: ["project_1", 2, 2, "session_b", 10],
      },
    ];

    for (const testCase of cases) {
      const parsed = parseSessionListQuery(new URLSearchParams(testCase.query));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;

      expect(buildSessionsQuery("project_1", parsed.options)).toEqual({
        sql: testCase.sql,
        bindings: testCase.bindings,
      });
    }
  });

  it("builds exact pages SQL after a null cursor", () => {
    const parsed = parseSessionListQuery(
      new URLSearchParams("sort=pages&before=pages:null:session_b&limit=10"),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(buildSessionsQuery("project_1", parsed.options)).toEqual({
      sql: "SELECT session_id, project_id, org_id, started_at, ended_at, duration_ms, country, region, city, device, browser, os, entry_url, url_count, page_count, analytics_version, max_scroll_depth, quick_backs, interaction_time_ms, activity_hist, clicks, errors, rages, navs, bytes, segment_count, flags, manifest_key, expires_at FROM sessions WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM session_deletions d WHERE d.project_id = sessions.project_id AND d.session_id = sessions.session_id) AND (page_count IS NULL AND session_id < ?) ORDER BY page_count IS NULL, page_count DESC, session_id DESC LIMIT ?",
      bindings: ["project_1", "session_b", 10],
    });
  });

  it("encodes sort-aware sessions cursors while preserving newest", () => {
    expect(encodeSessionCursor({ started_at: 3000, session_id: "session_b" })).toBe(
      "3000:session_b",
    );
    expect(encodeSessionCursor({ duration_ms: 2500, session_id: "session_b" }, "duration")).toBe(
      "duration:2500:session_b",
    );
    expect(encodeSessionCursor({ clicks: 3, session_id: "session_b" }, "clicks")).toBe(
      "clicks:3:session_b",
    );
    expect(
      encodeSessionCursor({ clicks: 2, errors: 1, rages: 1, session_id: "session_b" }, "friction"),
    ).toBe("friction:1102:session_b");
    expect(encodeSessionCursor({ page_count: 2, session_id: "session_b" }, "pages")).toBe(
      "pages:2:session_b",
    );
    expect(encodeSessionCursor({ page_count: null, session_id: "session_b" }, "pages")).toBe(
      "pages:null:session_b",
    );
  });

  it("uses the default sessions limit and newest sort", () => {
    const parsed = parseSessionListQuery(new URLSearchParams());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.options.limit).toBe(50);
    expect(parsed.options.sort).toBe("newest");
  });

  it("accepts only the whitelisted sessions sorts", () => {
    for (const sort of ["newest", "friction", "duration", "clicks", "pages"] as const) {
      const parsed = parseSessionListQuery(new URLSearchParams(`sort=${sort}`));
      expect(parsed).toMatchObject({ ok: true, options: { sort } });
    }

    expect(parseSessionListQuery(new URLSearchParams("sort=oldest"))).toEqual({
      ok: false,
      error: "invalid_sort",
    });
    expect(parseSessionListQuery(new URLSearchParams("sort="))).toEqual({
      ok: false,
      error: "invalid_sort",
    });
    expect(parseSessionListQuery(new URLSearchParams("sort=newest&sort=duration"))).toEqual({
      ok: false,
      error: "invalid_sort",
    });
  });

  it("rejects cursors from a different sessions sort", () => {
    for (const query of [
      "sort=duration&before=3000:session_b",
      "sort=friction&before=clicks:3:session_b",
      "sort=duration&before=clicks:3:session_b",
      "sort=clicks&before=duration:2500:session_b",
      "sort=pages&before=duration:2500:session_b",
      "sort=newest&before=pages:2:session_b",
    ]) {
      expect(parseSessionListQuery(new URLSearchParams(query))).toEqual({
        ok: false,
        error: "invalid_before",
      });
    }
  });

  it("rejects bad number filters", () => {
    expect(parseSessionListQuery(new URLSearchParams("limit=0"))).toEqual({
      ok: false,
      error: "invalid_limit",
    });
    expect(parseSessionListQuery(new URLSearchParams("before=-1"))).toEqual({
      ok: false,
      error: "invalid_before",
    });
    expect(parseSessionListQuery(new URLSearchParams("before=3000:bad/session"))).toEqual({
      ok: false,
      error: "invalid_before",
    });
    expect(parseSessionListQuery(new URLSearchParams("min_duration_ms=slow"))).toEqual({
      ok: false,
      error: "invalid_min_duration_ms",
    });
    expect(parseSessionListQuery(new URLSearchParams("from=2000&to=1000"))).toEqual({
      ok: false,
      error: "invalid_to",
    });
    expect(parseSessionListQuery(new URLSearchParams("has_errors=yes"))).toEqual({
      ok: false,
      error: "invalid_has_errors",
    });
    expect(parseSessionListQuery(new URLSearchParams("has_rage=yes"))).toEqual({
      ok: false,
      error: "invalid_has_rage",
    });
  });
});

describe("stats api decisions", () => {
  it("validates only the shared session filter", () => {
    expect(parseStatsFilter(new URLSearchParams("country=US&device=desktop"))).toEqual({
      ok: true,
      filter: { country: "US", device: "desktop" },
    });
    expect(parseStatsFilter(new URLSearchParams("limit=5"))).toEqual({
      ok: false,
      error: "invalid_limit",
    });
  });

  it("builds prepared aggregate, median, breakdown, and error queries", () => {
    const filter = { from: 1000, country: "US", has_errors: true } as const;

    expect(buildAggregateStatsQuery("project_1", filter)).toMatchObject({
      sql: expect.stringContaining("FROM sessions s WHERE s.project_id = ?"),
      bindings: ["project_1", 1000, "US", 1],
    });
    expect(buildMedianDurationQuery("project_1", filter, 4)).toMatchObject({
      sql: expect.stringContaining("ORDER BY s.duration_ms ASC LIMIT ? OFFSET ?"),
      bindings: ["project_1", 1000, "US", 1, 2, 1],
    });
    expect(buildBreakdownQuery("project_1", filter, "browser")).toMatchObject({
      sql: expect.stringContaining("GROUP BY s.browser"),
      bindings: ["project_1", 1000, "US", 1, "", 5],
    });
    expect(buildErrorGroupsQuery("project_1", filter)).toMatchObject({
      sql: expect.stringContaining("COUNT(DISTINCT e.session_id) AS affected_sessions"),
      bindings: ["Unknown error", "project_1", 1000, "US", 1, "error", "Unknown error", 5],
    });
  });

  it("uses one canonical cache key for equivalent filters", () => {
    const first = statsCacheRequest("project_1", { browser: "Chrome", country: "US" });
    const second = statsCacheRequest("project_1", { country: "US", browser: "Chrome" });

    expect(first.url).toBe(second.url);
    expect(new URL(first.url).search).toBe("?country=US&browser=Chrome");
  });

  it("filters live presence without using finalized-session cache data", () => {
    const sessions = [
      {
        session_id: "live_1",
        started_at: 1000,
        last_seen: 1900,
        entry_url: "/checkout/start",
        country: "US",
        city: "Austin",
        browser: "Chrome",
        os: "macOS",
        device: "desktop",
      },
      {
        session_id: "live_2",
        started_at: 1500,
        last_seen: 1900,
        entry_url: "/pricing",
        country: "IN",
        city: "Bengaluru",
        browser: "Firefox",
        os: "Android",
        device: "mobile",
      },
    ];

    expect(
      countFilteredLiveSessions(
        sessions,
        { country: "US", entry_url_prefix: "/checkout", min_duration_ms: 500 },
        2000,
      ),
    ).toBe(1);
    expect(countFilteredLiveSessions(sessions, { region: "CA" }, 2000)).toBe(0);
    expect(countFilteredLiveSessions(sessions, { has_rage: true }, 2000)).toBe(0);
  });
});

describe("api wide events", () => {
  it("logs the live route without the query token", async () => {
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const request = new Request(
      "https://replay.test/api/v1/projects/project_1/sessions/session_1/live?token=secret-token",
    );

    const response = await handleApi(
      request,
      { DEV_API_TOKEN: "different" } as Env,
      {} as Parameters<typeof handleApi>[2],
    );

    expect(response.status).toBe(401);
    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed["route"]).toBe("live");
    expect(JSON.stringify(parsed)).not.toContain("token=");
    expect(JSON.stringify(parsed)).not.toContain("secret-token");
  });

  it("logs demo discovery with the demo auth mode", async () => {
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const rateLimitKeys: string[] = [];
    const env = {
      DEMO_PROJECT_ID: "demo_project",
      DEMO_WRITE_KEY: "or_live_demo0000000000000000000000000000",
      DEMO_API_RATE_LIMITER: {
        async limit(input: { key: string }): Promise<{ success: boolean }> {
          rateLimitKeys.push(input.key);
          return { success: true };
        },
      },
    } as Env;

    const response = await handleApi(
      new Request("https://replay.test/api/v1/demo", {
        headers: { "cf-connecting-ip": "198.51.100.4" },
      }),
      env,
      {} as Parameters<typeof handleApi>[2],
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await response.json()).toEqual({
      projectId: "demo_project",
      writeKey: "or_live_demo0000000000000000000000000000",
    });
    expect(rateLimitKeys).toEqual(["demo:ip:198.51.100.4"]);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed["route"]).toBe("demo_discovery");
    expect(parsed["auth_mode"]).toBe("demo");
  });

  it("logs bearer auth mode for bearer-checked API routes", async () => {
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const bearerToken = "test-token-0000000000000000000000";

    const response = await handleApi(
      new Request("https://replay.test/api/v1/projects/other_project/sessions", {
        headers: { authorization: `Bearer ${bearerToken}` },
      }),
      { DEV_API_TOKEN: bearerToken, DEV_API_PROJECT_IDS: "demo_project" } as Env,
      {} as Parameters<typeof handleApi>[2],
    );

    expect(response.status).toBe(403);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed["auth_mode"]).toBe("bearer");
  });

  it("logs stats cache state even when its filter is invalid", async () => {
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const bearerToken = "test-token-0000000000000000000000";

    const response = await handleApi(
      new Request("https://replay.test/api/v1/projects/project_1/stats?limit=5", {
        headers: { authorization: `Bearer ${bearerToken}` },
      }),
      { DEV_API_TOKEN: bearerToken, DEV_API_PROJECT_IDS: "project_1" } as Env,
      {} as Parameters<typeof handleApi>[2],
    );

    expect(response.status).toBe(400);
    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed["route"]).toBe("project_stats");
    expect(parsed["cache_hit"]).toBe(false);
    expect(parsed["duration_ms"]).toEqual(expect.any(Number));
  });
});

describe("demo api decisions", () => {
  it("returns a generic 404 when demo env is incomplete", async () => {
    vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);

    const response = await handleApi(
      new Request("https://replay.test/api/v1/demo"),
      { DEMO_PROJECT_ID: "demo_project" } as Env,
      {} as Parameters<typeof handleApi>[2],
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("fails closed when demo rate limiting is missing outside dev test mode", async () => {
    vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);

    const response = await handleApi(
      new Request("https://replay.test/api/v1/demo"),
      {
        WORKER_ENV: "production",
        DEMO_PROJECT_ID: "demo_project",
        DEMO_WRITE_KEY: "or_live_demo0000000000000000000000000000",
      } as Env,
      {} as Parameters<typeof handleApi>[2],
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });

  it("rate limits demo context requests by client IP", async () => {
    vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const rateLimitKeys: string[] = [];

    const response = await handleApi(
      new Request("https://replay.test/api/v1/projects/demo_project/sessions", {
        headers: { "cf-connecting-ip": "203.0.113.8" },
      }),
      {
        DEMO_PROJECT_ID: "demo_project",
        DEMO_WRITE_KEY: "or_live_demo0000000000000000000000000000",
        DEMO_API_RATE_LIMITER: {
          async limit(input: { key: string }): Promise<{ success: boolean }> {
            rateLimitKeys.push(input.key);
            return { success: false };
          },
        },
      } as Env,
      {} as Parameters<typeof handleApi>[2],
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(rateLimitKeys).toEqual(["demo:ip:203.0.113.8"]);
  });

  it("does not expose dev test routes in production demo mode", () => {
    // index.ts only mounts /__test/* when isDevTestMode(env) is true; demo env
    // vars must never influence that gate.
    expect(
      isDevTestMode({
        WORKER_ENV: "production",
        DEMO_PROJECT_ID: "demo_project",
        DEMO_WRITE_KEY: "or_live_demo0000000000000000000000000000",
      } as Env),
    ).toBe(false);
    expect(
      isDevTestMode({
        WORKER_ENV: "production",
        DEV_TEST_ROUTES: "1",
        DEMO_PROJECT_ID: "demo_project",
        DEMO_WRITE_KEY: "or_live_demo0000000000000000000000000000",
      } as Env),
    ).toBe(false);
    expect(isDevTestMode({ WORKER_ENV: "development", DEV_TEST_ROUTES: "1" } as Env)).toBe(true);
  });
});
