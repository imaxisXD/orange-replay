import { describe, expect, it } from "vite-plus/test";
import type { LiveSessionItem } from "../src/lib/api";
import { formatLiveSessionRow, shouldPollLiveSessions } from "../src/lib/live-sessions";

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
