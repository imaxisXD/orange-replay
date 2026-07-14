import { describe, expect, it } from "vite-plus/test";
import type { SessionHead, SessionListItem } from "../src/lib/api";
import {
  canMergeSessionHeads,
  mergeSessionRows,
  nextTrackedSessionHeadIds,
  sessionHeadsFilter,
} from "../src/lib/session-list";

describe("session list continuity", () => {
  it("keeps one row and prefers R2 over exact D1 and provisional data", () => {
    const provisional = makeHead("same", "provisional", { clicks: 0 });
    const d1 = makeHead("same", "exact", { clicks: 4 });
    const r2 = makeSession("same", { clicks: 7 });

    const rows = mergeSessionRows([r2], [provisional, d1], "newest");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: "same",
      clicks: 7,
      details_state: "exact",
      row_source: "r2",
    });
  });

  it("prefers exact D1 over a provisional head before R2 catches up", () => {
    const rows = mergeSessionRows(
      [],
      [makeHead("same", "provisional", { clicks: 0 }), makeHead("same", "exact", { clicks: 5 })],
      "newest",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clicks: 5, details_state: "exact", row_source: "d1" });
  });

  it("sorts combined rows without changing the warehouse page", () => {
    const warehouse = [makeSession("older", { started_at: 1_000 })];
    const snapshot = [...warehouse];
    const rows = mergeSessionRows(
      warehouse,
      [makeHead("live", "provisional", { started_at: 2_000 })],
      "newest",
    );

    expect(rows.map((row) => row.session_id)).toEqual(["live", "older"]);
    expect(warehouse).toEqual(snapshot);
  });

  it("does not merge heads into a pinned metric doorway", () => {
    expect(canMergeSessionHeads({ country: "US" })).toBe(true);
    expect(canMergeSessionHeads({ warehouse_version: 24 })).toBe(false);
    expect(canMergeSessionHeads({}, "friction")).toBe(false);
    expect(canMergeSessionHeads({ has_errors: true }, "newest")).toBe(false);
  });

  it("keeps the default head overlay open for sessions started after the page opened", () => {
    expect(
      sessionHeadsFilter({ from: 1_000, to: 2_000, country: "US" }, { country: "US" }, 24),
    ).toEqual({ from: 1_000, country: "US", warehouse_version: 24 });
  });

  it("keeps a date chosen in the URL fixed for heads", () => {
    const fixedRange = { from: 1_000, to: 2_000, country: "US" };
    expect(sessionHeadsFilter(fixedRange, fixedRange, 24)).toEqual({
      ...fixedRange,
      warehouse_version: 24,
    });
  });

  it("tracks only heads that are still missing from the exact session page", () => {
    const first = makeHead("first", "provisional");
    const second = makeHead("second", "exact");

    expect(nextTrackedSessionHeadIds([], [first, second], [])).toEqual(["first", "second"]);
    expect(nextTrackedSessionHeadIds(["second"], [first, second], [])).toEqual(["second", "first"]);
    expect(nextTrackedSessionHeadIds(["second"], [first, second], [makeSession("second")])).toEqual(
      ["first"],
    );
    expect(nextTrackedSessionHeadIds(["second"], [first], [])).toEqual(["first"]);
  });

  it("keeps an older tracked head through two 200-row bridge polls", () => {
    const oldTracked = makeHead("old-tracked", "exact", { started_at: 1 });
    const newerHeads = Array.from({ length: 100 }, (_, index) =>
      makeHead(`new-${String(index).padStart(3, "0")}`, "exact", {
        started_at: 1_000 - index,
      }),
    );
    const responseHeads = [...newerHeads, oldTracked];

    const afterFirstPoll = nextTrackedSessionHeadIds([oldTracked.session_id], responseHeads, []);
    const afterSecondPoll = nextTrackedSessionHeadIds(afterFirstPoll, responseHeads, []);

    expect(afterFirstPoll).toHaveLength(100);
    expect(afterFirstPoll[0]).toBe(oldTracked.session_id);
    expect(afterSecondPoll[0]).toBe(oldTracked.session_id);
    expect(afterSecondPoll).toContain(oldTracked.session_id);
  });
});

function makeHead(
  sessionId: string,
  detailsState: SessionHead["details_state"],
  overrides: Partial<SessionHead> = {},
): SessionHead {
  return {
    ...makeSession(sessionId),
    activity: detailsState === "exact" ? "complete" : "live",
    details_state: detailsState,
    replay_source: detailsState === "exact" ? "recorded" : "live",
    ...overrides,
  };
}

function makeSession(sessionId: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
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
    activity_hist: null,
    clicks: 0,
    errors: 0,
    rages: 0,
    navs: 0,
    bytes: 100,
    segment_count: 1,
    flags: 0,
    manifest_key: `p/p1/${sessionId}/manifest.json`,
    expires_at: 9_999,
    ...overrides,
  };
}
