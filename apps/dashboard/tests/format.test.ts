import { describe, expect, it } from "vite-plus/test";
import type { SessionListItem } from "../src/lib/api";
import { formatBytes, formatDuration, formatRelativeTime } from "../src/lib/format";
import { appendUniqueSessions, canLoadMore } from "../src/lib/session-list";

describe("format helpers", () => {
  it("formats relative time in simple units", () => {
    const now = 1_000_000;

    expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 45_000, now)).toBe("45s ago");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe("3h ago");
  });

  it("formats duration and bytes", () => {
    expect(formatDuration(1_500)).toBe("2s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_536)).toBe("1.5 KB");
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
