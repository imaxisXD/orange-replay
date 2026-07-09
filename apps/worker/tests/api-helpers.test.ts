import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildSessionsQuery,
  encodeSessionCursor,
  isValidPathId,
  isValidSegmentName,
  parseSessionListQuery,
} from "../src/api/helpers.ts";
import { handleApi } from "../src/api/handler.ts";
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
        "limit=250&before=3000&country=US&browser=Chrome&has_errors=1&min_duration_ms=500",
      ),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const query = buildSessionsQuery("project_1", parsed.options);
    expect(query).toEqual({
      sql: "SELECT session_id, project_id, org_id, started_at, ended_at, duration_ms, country, region, city, device, browser, os, entry_url, url_count, clicks, errors, rages, navs, bytes, segment_count, flags, manifest_key, expires_at FROM sessions INDEXED BY idx_sessions_project_time WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM session_deletions d WHERE d.project_id = sessions.project_id AND d.session_id = sessions.session_id) AND started_at < ? AND country = ? AND browser = ? AND errors > 0 AND duration_ms >= ? ORDER BY started_at DESC, session_id DESC LIMIT ?",
      bindings: ["project_1", 3000, "US", "Chrome", 500, 100],
    });
  });

  it("builds a compound cursor query for same-millisecond pages", () => {
    const parsed = parseSessionListQuery(new URLSearchParams("before=3000:session_b&limit=10"));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const query = buildSessionsQuery("project_1", parsed.options);
    expect(query).toEqual({
      sql: "SELECT session_id, project_id, org_id, started_at, ended_at, duration_ms, country, region, city, device, browser, os, entry_url, url_count, clicks, errors, rages, navs, bytes, segment_count, flags, manifest_key, expires_at FROM sessions INDEXED BY idx_sessions_project_time WHERE project_id = ? AND NOT EXISTS (SELECT 1 FROM session_deletions d WHERE d.project_id = sessions.project_id AND d.session_id = sessions.session_id) AND (started_at < ? OR (started_at = ? AND session_id < ?)) ORDER BY started_at DESC, session_id DESC LIMIT ?",
      bindings: ["project_1", 3000, 3000, "session_b", 10],
    });
  });

  it("encodes the next sessions cursor as an opaque string", () => {
    expect(encodeSessionCursor({ started_at: 3000, session_id: "session_b" })).toBe(
      "3000:session_b",
    );
  });

  it("uses the default sessions limit", () => {
    const parsed = parseSessionListQuery(new URLSearchParams());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.options.limit).toBe(50);
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
