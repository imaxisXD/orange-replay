// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import type { IndexEvent } from "@orange-replay/shared/types";
import {
  buildTimelineTickBuckets,
  getPlayerKeyAction,
  mapTimelineSidebarRows,
  timeToTimelineX,
  timelineXToTime,
} from "../src/lib/replay-timeline";

describe("timeline tick buckets", () => {
  it("buckets activity events and scales tick heights", () => {
    const events: IndexEvent[] = [
      { t: 1_000, k: "click" },
      { t: 1_250, k: "scroll" },
      { t: 3_000, k: "input" },
      { t: 5_000, k: "error" },
      { t: 9_900, k: "rage" },
    ];

    const buckets = buildTimelineTickBuckets(events, {
      startedAt: 1_000,
      durationMs: 10_000,
      bucketCount: 4,
      minHeightPx: 4,
      maxHeightPx: 18,
    });

    expect(buckets.map((bucket) => bucket.count)).toEqual([3, 0, 0, 1]);
    expect(buckets[0]?.heightPx).toBe(18);
    expect(buckets[3]?.heightPx).toBeGreaterThan(0);
    expect(buckets[1]?.heightPx).toBe(0);
  });
});

describe("timeline seek math", () => {
  it("maps time to x and clamps to the timeline width", () => {
    expect(timeToTimelineX(5_000, 10_000, 200)).toBe(100);
    expect(timeToTimelineX(-1_000, 10_000, 200)).toBe(0);
    expect(timeToTimelineX(12_000, 10_000, 200)).toBe(200);
  });

  it("maps x to time and clamps to the session duration", () => {
    expect(timelineXToTime(50, 10_000, 200)).toBe(2_500);
    expect(timelineXToTime(-50, 10_000, 200)).toBe(0);
    expect(timelineXToTime(250, 10_000, 200)).toBe(10_000);
  });
});

describe("event sidebar rows", () => {
  it("maps displayable events and filters noisy types", () => {
    const rows = mapTimelineSidebarRows(
      [
        { t: 1_000, k: "scroll" },
        { t: 2_000, k: "click", d: "main > button.buy-now", m: { text: "Buy now" } },
        { t: 3_000, k: "error", d: "Checkout failed", m: { source: "console" } },
        { t: 4_000, k: "rage", m: { selector: ".quantity-stepper" } },
        { t: 5_000, k: "nav", d: "https://example.com/pricing?plan=pro" },
      ],
      { startedAt: 1_000, durationMs: 8_000 },
    );

    expect(rows).toEqual([
      {
        id: "click-2000-0",
        type: "click",
        dot: "blue",
        label: "button.buy-now",
        detail: "Buy now",
        offsetMs: 1_000,
        offsetLabel: "0:01",
      },
      {
        id: "error-3000-1",
        type: "error",
        dot: "danger",
        label: "Checkout failed",
        detail: "console",
        offsetMs: 2_000,
        offsetLabel: "0:02",
      },
      {
        id: "rage-4000-2",
        type: "rage",
        dot: "amber",
        label: "Rage click",
        detail: ".quantity-stepper",
        offsetMs: 3_000,
        offsetLabel: "0:03",
      },
      {
        id: "nav-5000-3",
        type: "nav",
        dot: "teal",
        label: "→ /pricing?plan=pro",
        offsetMs: 4_000,
        offsetLabel: "0:04",
      },
    ]);
  });
});

describe("keyboard controls", () => {
  it("maps playback keys to player actions", () => {
    expect(getPlayerKeyAction({ key: " ", target: document.body })).toEqual({
      type: "toggle-play",
    });
    expect(getPlayerKeyAction({ key: "ArrowLeft", target: document.body })).toEqual({
      type: "seek",
      deltaMs: -5000,
    });
    expect(getPlayerKeyAction({ key: "ArrowRight", target: document.body })).toEqual({
      type: "seek",
      deltaMs: 5000,
    });
    expect(getPlayerKeyAction({ key: "Escape", target: document.body })).toBeNull();
  });

  it("ignores player keys while typing", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.contentEditable = "true";

    expect(getPlayerKeyAction({ key: " ", target: input })).toBeNull();
    expect(getPlayerKeyAction({ key: "ArrowRight", target: editable })).toBeNull();
  });
});
