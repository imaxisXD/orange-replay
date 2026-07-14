// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionManifest } from "@orange-replay/shared/types";
import type { SessionHead } from "../src/lib/api";
import {
  loadSessionView,
  sessionHeadManifest,
  shouldPollSessionState,
} from "../src/routes/session-detail/session-detail-data";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState({}, "", "/demo/sessions/live");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("session detail state", () => {
  it("uses one live head without waiting for a final manifest", async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeHead({ replay_source: "live" })));

    const result = await loadSessionView("p1", "session_1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      mode: "live",
      notFound: false,
      activity: "live",
      detailsState: "provisional",
    });
    expect(result.manifest?.sessionId).toBe("session_1");
    expect(result.manifest?.segments).toEqual([]);
  });

  it("loads the immutable manifest when the state becomes recorded", async () => {
    const manifest = makeManifest();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(makeHead({ activity: "finalizing", replay_source: "recorded" })),
      )
      .mockResolvedValueOnce(jsonResponse(manifest));

    const result = await loadSessionView("p1", "session_1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe("recorded");
    expect(result.manifest).toEqual(manifest);
  });

  it("returns not found only when the per-session state is gone", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "session_not_found" }, 404));

    await expect(loadSessionView("p1", "missing")).resolves.toMatchObject({
      manifest: null,
      notFound: true,
    });
  });

  it("polls provisional details only while the page is visible", () => {
    expect(shouldPollSessionState("provisional", "visible")).toBe(true);
    expect(shouldPollSessionState("provisional", "hidden")).toBe(false);
    expect(shouldPollSessionState("exact", "visible")).toBe(false);
  });

  it("builds honest live metadata from a head", () => {
    const manifest = sessionHeadManifest(
      makeHead({
        country: " us ",
        entry_url: " https://example.com/checkout ",
        duration_ms: 8_000,
      }),
    );

    expect(manifest).toMatchObject({
      sessionId: "session_1",
      durationMs: 8_000,
      attrs: { country: "us", entryUrl: "https://example.com/checkout" },
    });
  });
});

function makeHead(overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    session_id: "session_1",
    project_id: "p1",
    org_id: "o1",
    started_at: 1_000,
    ended_at: 6_000,
    duration_ms: 5_000,
    country: "US",
    region: null,
    city: "New York",
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    entry_url: "/checkout",
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
    flags: 3,
    manifest_key: "p/p1/session_1/manifest.json",
    expires_at: 9_999,
    activity: "live",
    details_state: "provisional",
    replay_source: "live",
    ...overrides,
  };
}

function makeManifest(): SessionManifest {
  return {
    v: 1,
    sessionId: "session_1",
    projectId: "p1",
    orgId: "o1",
    startedAt: 1_000,
    endedAt: 6_000,
    durationMs: 5_000,
    segments: [],
    timeline: [],
    counts: { batches: 1, events: 2, clicks: 0, errors: 0, rages: 0, navs: 0 },
    bytes: 100,
    flags: 0,
    attrs: {},
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
