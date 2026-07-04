import { describe, expect, it } from "vite-plus/test";
import type { IndexEvent } from "@orange-replay/shared/types";
import { applySkipInactivity, buildTimeline, findInactivityGaps } from "../src/timeline.ts";

const startedAt = 1_000;

describe("timeline logic", () => {
  it("builds instant ticks, markers, duration, and counts from index events", () => {
    const events: IndexEvent[] = [
      { t: 1_100, k: "click", d: "button" },
      { t: 2_000, k: "error", d: "failed" },
      { t: 3_000, k: "rage", d: "rage" },
      { t: 4_000, k: "nav", d: "/next" },
      { t: 5_000, k: "custom", d: "checkout" },
      { t: 6_000, k: "vital", d: "lcp" },
    ];

    const timeline = buildTimeline(events, { startedAt, durationMs: 10_000, tickCount: 5 });

    expect(timeline.durationMs).toBe(10_000);
    expect(timeline.ticks).toHaveLength(5);
    expect(timeline.ticks.reduce((total, tick) => total + tick.count, 0)).toBe(events.length);
    expect(timeline.markers.map((marker) => marker.kind)).toEqual([
      "click",
      "error",
      "rage",
      "nav",
      "custom",
    ]);
    expect(timeline.counts).toEqual({
      clicks: 1,
      errors: 1,
      rages: 1,
      navs: 1,
      customs: 1,
    });
  });

  it("finds inactivity gaps over five seconds from user timeline events", () => {
    const events: IndexEvent[] = [
      { t: 1_000, k: "click" },
      { t: 3_000, k: "error" },
      { t: 7_100, k: "scroll" },
      { t: 8_000, k: "vital" },
      { t: 12_500, k: "input" },
    ];

    const gaps = findInactivityGaps(events, { startedAt, durationMs: 20_000 });

    expect(gaps).toEqual([
      { startMs: 0, endMs: 6_100, durationMs: 6_100 },
      { startMs: 6_100, endMs: 11_500, durationMs: 5_400 },
    ]);
  });

  it("keeps progress monotonic while skipping an inactive gap", () => {
    const gaps = [{ startMs: 2_000, endMs: 8_000, durationMs: 6_000 }];

    expect(applySkipInactivity(1_900, 2_100, gaps)).toEqual({
      timeMs: 8_000,
      skipped: true,
    });
    expect(applySkipInactivity(8_000, 7_000, gaps)).toEqual({
      timeMs: 8_000,
      skipped: false,
    });
  });
});
