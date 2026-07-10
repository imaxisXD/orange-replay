import { EventType, IncrementalSource, type eventWithTime } from "rrweb";
import type { IndexEvent } from "@orange-replay/shared/types";
import { describe, expect, it } from "vite-plus/test";
import { bucketActivity, detectDeadClicks } from "../src/friction.ts";

describe("dead click detection", () => {
  it("detects a click with no visible result", () => {
    expect(
      detectDeadClicks(
        [event(2_000, EventType.Load)],
        [
          { t: 1_000, k: "click", m: { selector: "button.save" } },
          { t: 2_000, k: "scroll" },
        ],
      ),
    ).toEqual([{ t: 1_000, detail: "button.save" }]);
  });

  it("does not flag clicks followed by a mutation", () => {
    expect(
      detectDeadClicks(
        [mutation(1_600), event(2_000, EventType.Load)],
        [{ t: 1_000, k: "click", d: "button" }],
      ),
    ).toEqual([]);
  });

  it("does not flag clicks followed by decoded or indexed navigation", () => {
    expect(
      detectDeadClicks(
        [event(1_500, EventType.Meta), event(2_000, EventType.Load)],
        [{ t: 1_000, k: "click", d: "first" }],
      ),
    ).toEqual([]);
    expect(
      detectDeadClicks(
        [event(2_000, EventType.Load)],
        [
          { t: 1_000, k: "click", d: "second" },
          { t: 1_600, k: "nav", d: "/next" },
        ],
      ),
    ).toEqual([]);
  });

  it("classifies a click that triggers an error as an error click", () => {
    expect(
      detectDeadClicks(
        [event(2_000, EventType.Load)],
        [
          { t: 1_000, k: "click", d: "button" },
          { t: 750, k: "error", d: "early error" },
        ],
      ),
    ).toEqual([]);
    expect(
      detectDeadClicks(
        [event(2_000, EventType.Load)],
        [
          { t: 1_000, k: "click", d: "button" },
          { t: 1_600, k: "error", d: "result error" },
        ],
      ),
    ).toEqual([]);
  });

  it("excludes blocked clicks and waits until the full result window is observed", () => {
    expect(
      detectDeadClicks([event(2_000, EventType.Load)], [{ t: 1_000, k: "click", d: "[blocked]" }]),
    ).toEqual([]);
    expect(
      detectDeadClicks([event(1_599, EventType.Load)], [{ t: 1_000, k: "click", d: "button" }]),
    ).toEqual([]);
  });

  it("uses strict window edges", () => {
    expect(
      detectDeadClicks(
        [mutation(1_000), event(2_000, EventType.Load)],
        [{ t: 1_000, k: "click", d: "button" }],
      ),
    ).toEqual([{ t: 1_000, detail: "button" }]);
    expect(
      detectDeadClicks(
        [mutation(1_601), event(2_000, EventType.Load)],
        [{ t: 1_000, k: "click", d: "button" }],
      ),
    ).toEqual([{ t: 1_000, detail: "button" }]);
  });

  it("handles the full timeline cap without nested event scans", () => {
    const clicks: IndexEvent[] = Array.from({ length: 10_000 }, (_unused, index) => ({
      t: 1_000 + index * 1_000,
      k: "click",
      d: `button-${index}`,
    }));

    const deadClicks = detectDeadClicks(
      [event((clicks.at(-1)?.t ?? 0) + 1_000, EventType.Load)],
      clicks,
    );

    expect(deadClicks).toHaveLength(10_000);
    expect(deadClicks.at(-1)).toEqual({ t: clicks.at(-1)?.t, detail: "button-9999" });
  });
});

describe("activity buckets", () => {
  it("returns empty buckets for an empty or zero-duration session", () => {
    expect(bucketActivity([], 0, 4)).toEqual([
      { index: 0, count: 0, intensity: 0 },
      { index: 1, count: 0, intensity: 0 },
      { index: 2, count: 0, intensity: 0 },
      { index: 3, count: 0, intensity: 0 },
    ]);
  });

  it("places a single event in the correct bucket", () => {
    const buckets = bucketActivity([{ t: 3_500, k: "click" }], 4_000, 4, 1_000);
    expect(buckets.map((bucket) => bucket.count)).toEqual([0, 0, 1, 0]);
    expect(buckets[2]?.intensity).toBe(1);
  });

  it("normalizes uniform activity and spikes", () => {
    const uniform = bucketActivity(
      [
        { t: 500, k: "click" },
        { t: 1_500, k: "scroll" },
        { t: 2_500, k: "error" },
        { t: 3_500, k: "nav" },
      ],
      4_000,
      4,
    );
    expect(uniform.map((bucket) => bucket.intensity)).toEqual([1, 1, 1, 1]);

    const spike = bucketActivity(
      [
        { t: 500, k: "click" },
        { t: 2_100, k: "click" },
        { t: 2_200, k: "click" },
        { t: 2_300, k: "click" },
      ],
      4_000,
      4,
    );
    expect(spike[0]?.intensity).toBeCloseTo(1 / 3);
    expect(spike[2]?.intensity).toBe(1);
  });
});

function event(timestamp: number, type: EventType): eventWithTime {
  return { type, timestamp, data: {} } as eventWithTime;
}

function mutation(timestamp: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp,
    data: { source: IncrementalSource.Mutation, texts: [], attributes: [], removes: [], adds: [] },
  } as eventWithTime;
}
