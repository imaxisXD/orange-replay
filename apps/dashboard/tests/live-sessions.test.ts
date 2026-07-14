import { describe, expect, it } from "vite-plus/test";
import type { LiveSessionItem, SessionHead } from "../src/lib/api";
import {
  activeSessionHeads,
  formatLiveSessionRow,
  shouldPollLiveSessions,
} from "../src/lib/live-sessions";

describe("live session rows", () => {
  it("formats the row from the API data", () => {
    expect(
      formatLiveSessionRow(
        makeLiveSession({
          entry_url: "https://example.com/checkout?plan=pro",
          country: "us",
          city: "San Francisco",
          browser: "Chrome",
          duration_ms: 252_000,
        }),
      ),
    ).toEqual({
      sessionId: "session_1",
      entryPath: "/checkout?plan=pro",
      countryCode: "US",
      placeText: "San Francisco · Chrome",
      elapsedTime: "4:12",
    });
  });

  it("falls back to the country code when city is missing", () => {
    expect(
      formatLiveSessionRow(
        makeLiveSession({
          country: "jp",
          city: null,
          browser: "Safari",
          duration_ms: 47_000,
        }),
      ).placeText,
    ).toBe("JP · Safari");
  });

  it("omits browser text when browser is missing", () => {
    expect(
      formatLiveSessionRow(
        makeLiveSession({
          country: "br",
          city: "Sao Paulo",
          browser: null,
        }),
      ).placeText,
    ).toBe("Sao Paulo");
  });

  it("omits browser text when browser says unknown", () => {
    expect(
      formatLiveSessionRow(
        makeLiveSession({
          country: "br",
          city: "Sao Paulo",
          browser: "Unknown",
        }),
      ).placeText,
    ).toBe("Sao Paulo");
  });

  it("keeps invalid countries out of the flag slot", () => {
    expect(
      formatLiveSessionRow(
        makeLiveSession({
          country: "not-a-country",
          city: "",
          browser: null,
        }),
      ),
    ).toMatchObject({
      countryCode: null,
      placeText: "NOT-A-COUNTRY",
    });
  });
});

describe("live polling", () => {
  it("polls while the page is visible", () => {
    expect(shouldPollLiveSessions("visible")).toBe(true);
  });

  it("pauses while the page is hidden", () => {
    expect(shouldPollLiveSessions("hidden")).toBe(false);
  });
});

describe("live session selection", () => {
  it("keeps only fresh live heads on the Live page", () => {
    const live = makeSessionHead("live", "live");
    const idle = makeSessionHead("idle", "idle");
    const finalizing = makeSessionHead("finalizing", "finalizing");

    expect(
      activeSessionHeads([live, idle, finalizing]).map((session) => session.session_id),
    ).toEqual(["live"]);
  });
});

function makeLiveSession(overrides: Partial<LiveSessionItem> = {}): LiveSessionItem {
  return {
    session_id: "session_1",
    started_at: 1_000,
    last_seen: 5_000,
    entry_url: "/pricing",
    country: "US",
    city: "New York",
    browser: "Chrome",
    os: "macOS",
    device: "desktop",
    duration_ms: 1_000,
    ...overrides,
  };
}

function makeSessionHead(sessionId: string, activity: SessionHead["activity"]): SessionHead {
  return {
    session_id: sessionId,
    project_id: "p1",
    org_id: "o1",
    started_at: 1_000,
    ended_at: 2_000,
    duration_ms: 1_000,
    country: "US",
    region: null,
    city: "New York",
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    entry_url: "/pricing",
    url_count: 0,
    page_count: null,
    analytics_version: 0,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    activity_hist: null,
    clicks: 0,
    errors: 0,
    rages: 0,
    navs: 0,
    bytes: 0,
    segment_count: 0,
    flags: 0,
    manifest_key: `p/p1/${sessionId}/manifest.json`,
    expires_at: 9_999,
    activity,
    details_state: activity === "complete" ? "exact" : "provisional",
    replay_source: activity === "finalizing" || activity === "complete" ? "recorded" : "live",
  };
}
