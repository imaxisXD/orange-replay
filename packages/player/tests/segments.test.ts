import { describe, expect, it } from "vite-plus/test";
import type { SegmentRef } from "@orange-replay/shared/types";
import { buildSegment } from "@orange-replay/shared/wire";
import {
  chooseSegmentWindow,
  findSegmentIndex,
  segmentRelativeRange,
  sliceSegmentBatches,
} from "../src/segments.ts";

const segments: SegmentRef[] = [
  { key: "p/project/session/seg-000001.ors", bytes: 10, t0: 1_000, t1: 4_000, batches: 1 },
  { key: "p/project/session/seg-000002.ors", bytes: 10, t0: 4_001, t1: 8_000, batches: 1 },
  { key: "p/project/session/seg-000003.ors", bytes: 10, t0: 8_001, t1: 12_000, batches: 1 },
];

describe("segment logic", () => {
  it("maps relative playback time to the matching segment", () => {
    expect(findSegmentIndex(segments, 1_000, 0)).toBe(0);
    expect(findSegmentIndex(segments, 1_000, 5_500)).toBe(1);
    expect(findSegmentIndex(segments, 1_000, 20_000)).toBe(2);
  });

  it("maps segment gaps and edges to the nearest useful segment", () => {
    const segmentsWithGap: SegmentRef[] = [
      { key: "p/project/session/seg-000001.ors", bytes: 10, t0: 1_000, t1: 2_000, batches: 1 },
      { key: "p/project/session/seg-000002.ors", bytes: 10, t0: 5_000, t1: 8_000, batches: 1 },
      { key: "p/project/session/seg-000003.ors", bytes: 10, t0: 9_000, t1: 12_000, batches: 1 },
    ];

    expect(findSegmentIndex(segmentsWithGap, 0, 500)).toBe(0);
    expect(findSegmentIndex(segmentsWithGap, 0, 2_500)).toBe(1);
    expect(findSegmentIndex(segmentsWithGap, 0, 20_000)).toBe(2);
  });

  it("chooses the active segment and the next prefetch segment", () => {
    expect(chooseSegmentWindow(segments, 1)).toEqual({
      activeIndex: 1,
      neededIndexes: [1],
      prefetchIndexes: [2],
    });
    expect(chooseSegmentWindow(segments, 2).prefetchIndexes).toEqual([]);
  });

  it("keeps ORS1 slicing delegated to shared wire helpers", () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    const sliced = sliceSegmentBatches(buildSegment([first, second]));

    expect(sliced.map((batch) => Array.from(batch))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
  });

  it("returns segment ranges relative to session start", () => {
    expect(segmentRelativeRange(segments[1]!, 1_000)).toEqual({ startMs: 3_001, endMs: 7_000 });
  });
});
