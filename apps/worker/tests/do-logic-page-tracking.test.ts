import { describe, expect, it } from "vite-plus/test";
import {
  MAX_TRACKED_PAGE_TABS,
  normalizeSessionAnalyticsVersion,
  rebuildFinalPageAnalytics,
  updatePageTrackingWithBatch,
} from "../src/do/session-page-tracking.ts";
import type { SessionState } from "../src/do/session-state.ts";
import type { StoredPageBatch } from "../src/do/session-page-tracking.ts";

describe("SessionRecorder pure logic", () => {
  it("does not count repeated same-URL timer batches", () => {
    const state: Pick<SessionState, "pageCount" | "pageTabs"> = { pageCount: 0, pageTabs: [] };

    updatePageTrackingWithBatch(state, "tab-a", { u: "/a", e: [] });
    updatePageTrackingWithBatch(state, "tab-a", { u: "/a", e: [] });

    expect(state.pageCount).toBe(1);
    expect(state.pageTabs).toEqual([{ tab: "tab-a", url: "/a" }]);
  });

  it("counts a same-URL full reload from the loader navigation vital", () => {
    const state: Pick<SessionState, "pageCount" | "pageTabs"> = { pageCount: 0, pageTabs: [] };

    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a",
      e: [{ t: 1, k: "vital", d: "navigation" }],
    });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a",
      e: [{ t: 2, k: "vital", d: "navigation" }],
    });

    expect(state.pageCount).toBe(2);
  });

  it("counts a landing and later client redirect in the same batch", () => {
    const state: Pick<SessionState, "pageCount" | "quickBacks" | "pageTabs"> = {
      pageCount: 0,
      quickBacks: 0,
      pageTabs: [],
    };

    updatePageTrackingWithBatch(state, "tab-a", { u: "/a", t0: 0, t1: 0, e: [] });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/c",
      t0: 1_000,
      t1: 2_000,
      e: [
        { t: 1_000, k: "vital", d: "navigation" },
        { t: 2_000, k: "nav", d: "/c" },
      ],
    });

    expect(state.pageCount).toBe(3);
    expect(state.pageTabs[0]).toMatchObject({ tab: "tab-a", url: "/c" });
    expect(state.pageTabs[0]?.previousUrl).not.toBe("/a");
  });

  it("keeps pre-page-tracking stored sessions on legacy analytics", () => {
    expect(normalizeSessionAnalyticsVersion(undefined, undefined)).toBe(0);
    expect(normalizeSessionAnalyticsVersion(undefined, 0)).toBe(2);
    expect(normalizeSessionAnalyticsVersion(undefined, -1)).toBe(0);
    expect(normalizeSessionAnalyticsVersion(1, undefined)).toBe(1);
  });

  it("counts A to B to A for compatible URL-only batches", () => {
    const state: Pick<SessionState, "pageCount" | "pageTabs"> = { pageCount: 0, pageTabs: [] };

    updatePageTrackingWithBatch(state, "tab-a", { u: "/a", e: [] });
    updatePageTrackingWithBatch(state, "tab-a", { u: "/b", e: [] });
    updatePageTrackingWithBatch(state, "tab-a", { u: "/a", e: [] });

    expect(state.pageCount).toBe(3);
  });

  it("counts SPA push and pop changes but ignores same-URL replace noise", () => {
    const state: Pick<SessionState, "pageCount" | "pageTabs"> = { pageCount: 0, pageTabs: [] };

    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a",
      e: [{ t: 1, k: "vital", d: "navigation" }],
    });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/b",
      e: [{ t: 2, k: "nav", d: "/b" }],
    });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a",
      e: [{ t: 3, k: "nav", d: "/a" }],
    });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a",
      e: [{ t: 4, k: "nav", d: "/a" }],
    });

    expect(state.pageCount).toBe(3);
  });

  it("keeps alternating tab journeys separate", () => {
    const state: Pick<SessionState, "pageCount" | "pageTabs"> = { pageCount: 0, pageTabs: [] };

    updatePageTrackingWithBatch(state, "tab-a", { u: "/a", e: [] });
    updatePageTrackingWithBatch(state, "tab-b", { u: "/b", e: [] });
    updatePageTrackingWithBatch(state, "tab-a", { u: "/a", e: [] });
    updatePageTrackingWithBatch(state, "tab-b", { u: "/b", e: [] });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a-2",
      e: [{ t: 5, k: "nav", d: "/a-2" }],
    });
    updatePageTrackingWithBatch(state, "tab-b", {
      u: "/b-2",
      e: [{ t: 6, k: "nav", d: "/b-2" }],
    });

    expect(state.pageCount).toBe(4);
    expect(state.pageTabs).toEqual([
      { tab: "tab-a", url: "/a-2", previousUrl: "/a", enteredAt: 5 },
      { tab: "tab-b", url: "/b-2", previousUrl: "/b", enteredAt: 6 },
    ]);
  });

  it("counts an in-app A to B to A quick back below ten seconds", () => {
    const state = { pageCount: 0, quickBacks: 0, pageTabs: [] };

    updatePageTrackingWithBatch(state, "tab-a", { u: "/a", t0: 0, t1: 0, e: [] });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/b",
      t0: 1_000,
      t1: 1_000,
      e: [{ t: 1_000, k: "nav", d: "/b" }],
    });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a",
      t0: 9_500,
      t1: 9_500,
      e: [{ t: 9_500, k: "nav", d: "/a" }],
    });

    expect(state.quickBacks).toBe(1);
  });

  it("counts quick backs across recorded full-load navigation markers", () => {
    const state = { pageCount: 0, quickBacks: 0, pageTabs: [] };

    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a",
      t0: 0,
      t1: 0,
      e: [{ t: 0, k: "vital", d: "navigation" }],
    });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/b",
      t0: 1_000,
      t1: 1_000,
      e: [{ t: 1_000, k: "vital", d: "navigation" }],
    });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a",
      t0: 9_000,
      t1: 9_000,
      e: [{ t: 9_000, k: "vital", d: "navigation" }],
    });

    expect(state.quickBacks).toBe(1);
  });

  it("does not combine quick backs across tabs or include a ten-second dwell", () => {
    const state = { pageCount: 0, quickBacks: 0, pageTabs: [] };

    updatePageTrackingWithBatch(state, "tab-a", { u: "/a", t0: 0, t1: 0, e: [] });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/b",
      t0: 1_000,
      t1: 1_000,
      e: [{ t: 1_000, k: "nav", d: "/b" }],
    });
    updatePageTrackingWithBatch(state, "tab-b", { u: "/a", t0: 2_000, t1: 2_000, e: [] });
    updatePageTrackingWithBatch(state, "tab-a", {
      u: "/a",
      t0: 11_000,
      t1: 11_000,
      e: [{ t: 11_000, k: "nav", d: "/a" }],
    });

    expect(state.quickBacks).toBe(0);
  });

  it("bounds the per-tab URL tracker", () => {
    const state: Pick<SessionState, "pageCount" | "pageTabs"> = { pageCount: 0, pageTabs: [] };

    for (let index = 0; index < MAX_TRACKED_PAGE_TABS + 3; index += 1) {
      updatePageTrackingWithBatch(state, `tab-${index}`, { u: `/page-${index}`, e: [] });
    }

    expect(state.pageTabs).toHaveLength(MAX_TRACKED_PAGE_TABS);
    expect(state.pageTabs[0]?.tab).toBe("tab-3");
  });

  it("rebuilds final page and quick-back metrics by tab sequence", () => {
    const state = {
      entryUrl: "/wrong",
      urlCount: 99,
      pageCount: 99,
      quickBacks: 99,
      pageTabs: [],
    };

    rebuildFinalPageAnalytics(state, [
      {
        tab: "tab-a",
        seq: 0,
        t0: 0,
        t1: 0,
        url: "/a",
        events: [],
        pageAnalyticsVersion: 1,
      },
      {
        tab: "tab-a",
        seq: 1,
        t0: 1_000,
        t1: 1_000,
        url: "/b",
        events: [{ t: 1_000, k: "nav", d: "/b" }],
        pageAnalyticsVersion: 1,
      },
      {
        tab: "tab-a",
        seq: 2,
        t0: 2_000,
        t1: 2_000,
        url: "/a",
        events: [{ t: 2_000, k: "nav", d: "/a" }],
        pageAnalyticsVersion: 1,
      },
    ]);

    expect(state).toMatchObject({
      entryUrl: "/a",
      urlCount: 3,
      pageCount: 3,
      quickBacks: 1,
    });
  });

  it("rebuilds final page analytics from a one-pass batch stream", () => {
    const state = {
      entryUrl: "/kept-until-stream-is-proven-compatible",
      urlCount: 99,
      pageCount: 99,
      quickBacks: 99,
      pageTabs: [],
    };
    let iteratorCount = 0;
    const batches: Iterable<StoredPageBatch> = {
      *[Symbol.iterator]() {
        iteratorCount += 1;
        if (iteratorCount > 1) throw new Error("page batches were read more than once");
        yield {
          tab: "tab-a",
          seq: 0,
          t0: 1_000,
          t1: 1_000,
          url: "/a",
          events: [],
          pageAnalyticsVersion: 1,
        };
        yield {
          tab: "tab-a",
          seq: 1,
          t0: 2_000,
          t1: 2_000,
          url: "/b",
          events: [{ t: 2_000, k: "nav", d: "/b" }],
          pageAnalyticsVersion: 1,
        };
      },
    };

    rebuildFinalPageAnalytics(state, batches);

    expect(iteratorCount).toBe(1);
    expect(state).toMatchObject({
      entryUrl: "/a",
      urlCount: 2,
      pageCount: 2,
      quickBacks: 0,
    });
  });

  it("keeps stored page analytics unchanged when a streamed legacy batch appears", () => {
    const state = {
      entryUrl: "/existing",
      urlCount: 4,
      pageCount: 5,
      quickBacks: 2,
      pageTabs: [{ tab: "tab-old", url: "/existing" }],
    };

    rebuildFinalPageAnalytics(state, [
      {
        tab: "tab-a",
        seq: 0,
        t0: 1_000,
        t1: 1_000,
        url: "/new",
        events: [],
        pageAnalyticsVersion: 1,
      },
      {
        tab: "tab-a",
        seq: 1,
        t0: 2_000,
        t1: 2_000,
        events: [],
        pageAnalyticsVersion: 0,
      },
    ]);

    expect(state).toEqual({
      entryUrl: "/existing",
      urlCount: 4,
      pageCount: 5,
      quickBacks: 2,
      pageTabs: [{ tab: "tab-old", url: "/existing" }],
    });
  });
});
