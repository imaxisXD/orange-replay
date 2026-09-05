import { describe, expect, it } from "vite-plus/test";
import { listReplayTabs, timelineForReplayTab } from "../src/tabs.ts";

describe("recording tabs", () => {
  it("orders friendly labels by first activity and shows paths without query secrets", () => {
    const timeline = [
      {
        t: 20,
        k: "nav" as const,
        tab: "opaque-b",
        d: "https://user:pass@example.test/checkout?token=secret#secret",
      },
      { t: 10, k: "nav" as const, tab: "opaque-a", d: "/catalog" },
      { t: 30, k: "error" as const, d: "Legacy error" },
    ];
    const tabs = listReplayTabs({
      timeline,
      segments: [
        {
          key: "p/p/s/seg-000001.ors",
          bytes: 100,
          batches: 2,
          t0: 10,
          t1: 30,
          checkpoints: [
            { tab: "opaque-b", timestamp: 22, batch: 1 },
            { tab: "opaque-a", timestamp: 12, batch: 0 },
          ],
        },
      ],
    });
    expect(tabs).toEqual([
      { id: "opaque-a", label: "Tab 1", path: "/catalog", firstEventAt: 10, firstSnapshotAt: 12 },
      { id: "opaque-b", label: "Tab 2", path: "/checkout", firstEventAt: 20, firstSnapshotAt: 22 },
    ]);
    expect(timelineForReplayTab(timeline, "opaque-b")).toEqual([timeline[0], timeline[2]]);
    expect(listReplayTabs({ timeline: [timeline[2]!], segments: [] })).toEqual([]);
  });
});
