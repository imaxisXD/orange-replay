import { describe, expect, it } from "vite-plus/test";
import { buildFinalizeTimelineData } from "../src/do/session-finalize-data.ts";

describe("tab-aware final timeline", () => {
  const rows = ["tab-a", "tab-b"].map((tab, index) => ({
    tab,
    events: JSON.stringify(
      [0, 1].map((offset) => ({
        t: 100 + index * 10 + offset,
        k: "click",
        m: { x: 0.1, y: 0.1, w: 100, h: 100 },
      })),
    ),
  }));
  it("does not combine clicks in different tabs into a rage burst", () => {
    const result = buildFinalizeTimelineData(rows, 100, 200);
    expect(result.counts.rages).toBe(0);
    expect(new Set(result.timeline.map((event) => event.tab))).toEqual(new Set(["tab-a", "tab-b"]));
  });
  it("rebuilds the previous analytics values when an immutable legacy manifest already exists", () => {
    const result = buildFinalizeTimelineData(rows, 100, 200, true);
    expect(result.counts.rages).toBe(1);
    expect(result.timeline.every((event) => event.tab === undefined)).toBe(true);
  });
});
