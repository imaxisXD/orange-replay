import { describe, expect, it } from "vite-plus/test";
import type { SessionManifest } from "@orange-replay/shared/types";
import {
  buildDeadClickMarkers,
  buildErrorMarkers,
  buildRageMarkers,
  firstErrorOffset,
  journeyDisplayItems,
} from "../src/routes/session-detail/replay-playback/replay-markers";

describe("replay timeline markers", () => {
  it("positions error and dead-click markers inside the timeline", () => {
    const manifest = makeManifest([
      { t: 1_500, k: "error", d: "failed" },
      { t: 12_000, k: "error", d: "late" },
    ]);

    expect(buildErrorMarkers(manifest)).toEqual([
      { id: "1500-failed", leftPercent: 5, offsetLabel: "0:01" },
      { id: "12000-late", leftPercent: 100, offsetLabel: "0:11" },
    ]);
    expect(buildDeadClickMarkers(manifest, [{ t: 500 }, { t: 11_500 }])).toEqual([
      { id: "500-0", leftPercent: 0 },
      { id: "11500-1", leftPercent: 100 },
    ]);
  });

  it("positions rage markers from timeline rage events only", () => {
    const manifest = makeManifest([
      { t: 3_500, k: "rage", d: "Rage click burst" },
      { t: 6_000, k: "click", d: "button" },
      { t: 8_500, k: "rage", d: "Rage click burst" },
    ]);

    expect(buildRageMarkers(manifest)).toEqual([
      { id: "3500-rage-0", leftPercent: 25, offsetLabel: "0:03" },
      { id: "8500-rage-1", leftPercent: 75, offsetLabel: "0:08" },
    ]);
  });

  it("seeks two seconds before the earliest error without going below zero", () => {
    expect(
      firstErrorOffset(
        makeManifest([
          { t: 6_000, k: "error" },
          { t: 1_500, k: "error" },
        ]),
      ),
    ).toBe(0);
    expect(firstErrorOffset(makeManifest([{ t: 5_000, k: "error" }]))).toBe(2_000);
    expect(firstErrorOffset(makeManifest([{ t: 2_000, k: "click" }]))).toBeNull();
  });

  it("collapses only the middle of a long page journey", () => {
    const breadcrumbs = Array.from({ length: 8 }, (_, index) => ({
      id: `page-${index}`,
      path: `/page-${index}`,
      offsetMs: index * 1_000,
    }));

    expect(journeyDisplayItems(breadcrumbs, false)).toEqual([
      breadcrumbs[0],
      breadcrumbs[1],
      { id: "collapsed", collapsedCount: 3 },
      breadcrumbs[5],
      breadcrumbs[6],
      breadcrumbs[7],
    ]);
    expect(journeyDisplayItems(breadcrumbs, true)).toEqual(breadcrumbs);
  });
});

function makeManifest(timeline: SessionManifest["timeline"]): SessionManifest {
  return {
    v: 1,
    sessionId: "session",
    projectId: "project",
    orgId: "org",
    startedAt: 1_000,
    endedAt: 11_000,
    durationMs: 10_000,
    segments: [],
    timeline,
    counts: { batches: 1, events: timeline.length, clicks: 0, errors: 0, rages: 0, navs: 0 },
    bytes: 0,
    flags: 0,
    attrs: {},
  };
}
