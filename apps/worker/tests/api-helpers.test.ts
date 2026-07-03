import { describe, expect, it } from "vite-plus/test";
import {
  buildSessionsQuery,
  isValidPathId,
  isValidSegmentName,
  parseSessionListQuery,
} from "../src/api/helpers.ts";

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
      sql: "SELECT session_id, project_id, org_id, started_at, ended_at, duration_ms, country, region, city, device, browser, os, entry_url, url_count, clicks, errors, rages, navs, bytes, segment_count, flags, manifest_key, expires_at FROM sessions INDEXED BY idx_sessions_project_time WHERE project_id = ? AND started_at < ? AND country = ? AND browser = ? AND errors > 0 AND duration_ms >= ? ORDER BY started_at DESC LIMIT ?",
      bindings: ["project_1", 3000, "US", "Chrome", 500, 100],
    });
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
    expect(parseSessionListQuery(new URLSearchParams("min_duration_ms=slow"))).toEqual({
      ok: false,
      error: "invalid_min_duration_ms",
    });
  });
});
