import { describe, expect, it } from "vite-plus/test";
import type { SessionListItem } from "../src/lib/api";
import {
  formatBytes,
  formatDuration,
  formatErrorCount,
  formatRelativeTime,
  formatShortRelativeTime,
} from "../src/lib/format";
import { appendUniqueSessions, canLoadMore } from "../src/lib/session-list";

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

  it("formats duration and bytes", () => {
    expect(formatDuration(1_500)).toBe("0:02");
    expect(formatDuration(22_000)).toBe("0:22");
    expect(formatDuration(184_000)).toBe("3:04");
    expect(formatDuration(612_000)).toBe("10:12");
    expect(formatDuration(3_661_000)).toBe("1:01:01");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(145 * 1_024)).toBe("145K");
    expect(formatBytes(512 * 1_024)).toBe("512K");
    expect(formatBytes(1.1 * 1_024 * 1_024)).toBe("1.1M");
    expect(formatBytes(3.3 * 1_024 * 1_024)).toBe("3.3M");
    expect(formatBytes(10 * 1_024 * 1_024)).toBe("10M");
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
});

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
