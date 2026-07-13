import { describe, expect, it } from "vite-plus/test";
import type { ListSessionsResponse, SessionListItem } from "../src/lib/api";
import {
  formatDuration,
  formatErrorCount,
  formatRelativeTime,
  formatShortRelativeTime,
} from "../src/lib/format";
import {
  appendUniqueSessions,
  canLoadMore,
  hasStaleAnalytics,
  nextSessionPageParam,
} from "../src/lib/session-list";

describe("format helpers", () => {
  it("formats relative time in simple units", () => {
    const now = 1_000_000;

    expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 45_000, now)).toBe("45s ago");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe("3h ago");
    expect(formatShortRelativeTime(now - 5_000, now)).toBe("now");
    expect(formatShortRelativeTime(now - 45_000, now)).toBe("45s");
    expect(formatShortRelativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(formatShortRelativeTime(now - 3 * 60 * 60_000, now)).toBe("3h");
  });

  it("formats duration and error counts", () => {
    expect(formatDuration(1_500)).toBe("0:02");
    expect(formatDuration(22_000)).toBe("0:22");
    expect(formatDuration(184_000)).toBe("3:04");
    expect(formatDuration(612_000)).toBe("10:12");
    expect(formatDuration(3_661_000)).toBe("1:01:01");
    expect(formatErrorCount(1)).toBe("1 error");
    expect(formatErrorCount(2)).toBe("2 errors");
  });
});

describe("cursor helpers", () => {
  it("knows when more pages can load", () => {
    expect(canLoadMore("1000:abc")).toBe(true);
    expect(canLoadMore("")).toBe(false);
    expect(canLoadMore(null)).toBe(false);
  });

  it("appends sessions without duplicate ids", () => {
    const first = makeSession("a");
    const duplicate = makeSession("a");
    const second = makeSession("b");

    expect(
      appendUniqueSessions([first], [duplicate, second]).map((session) => session.session_id),
    ).toEqual(["a", "b"]);
  });

  it("pins later pages to the first warehouse snapshot", () => {
    const firstPage = makePage("2000:session_b", 12, "fresh");

    expect(nextSessionPageParam(firstPage, [firstPage])).toEqual({
      before: "2000:session_b",
      warehouseVersion: 12,
    });
    expect(nextSessionPageParam(makePage(null, 12, "fresh"), [firstPage])).toBeUndefined();
  });

  it("finds stale analytics in any loaded page", () => {
    expect(
      hasStaleAnalytics([makePage("2000:session_b", 12, "fresh"), makePage(null, 12, "stale")]),
    ).toBe(true);
    expect(hasStaleAnalytics([makePage(null, 12, "fresh")])).toBe(false);
  });
});

function makePage(
  nextBefore: string | null,
  warehouseVersion: number,
  analyticsState: "fresh" | "stale",
): ListSessionsResponse {
  return { sessions: [], nextBefore, warehouseVersion, analyticsState };
}

function makeSession(sessionId: string): SessionListItem {
  return {
    session_id: sessionId,
    project_id: "p1",
    org_id: "o1",
    started_at: 1_000,
    ended_at: 2_000,
    duration_ms: 1_000,
    country: "US",
    region: null,
    city: null,
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    entry_url: "/",
    url_count: 1,
    page_count: 1,
    analytics_version: 1,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    clicks: 0,
    errors: 0,
    rages: 0,
    navs: 0,
    bytes: 100,
    segment_count: 1,
    flags: 0,
    manifest_key: "p/p1/a/manifest.json",
    expires_at: 9_999,
  };
}
