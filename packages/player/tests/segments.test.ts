import { describe, expect, it } from "vite-plus/test";
import type { SegmentRef } from "@orange-replay/shared/types";
import { buildSegment } from "@orange-replay/shared/wire";
import { EventType, IncrementalSource } from "rrweb";
import {
  chooseSegmentWindow,
  eventsFromCheckpoint,
  findPrimaryReplayTab,
  findSegmentIndex,
  sliceSegmentBatches,
  validateSegmentCheckpoints,
} from "../src/segments.ts";
import type { ReplayEvent } from "../src/types.ts";

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

  it("loads every earlier mutation segment before the active segment", () => {
    expect(chooseSegmentWindow(segments, 1)).toEqual({
      activeIndex: 1,
      startIndex: 0,
      neededIndexes: [0, 1],
      prefetchIndexes: [2],
    });
    expect(chooseSegmentWindow(segments, 2)).toEqual({
      activeIndex: 2,
      startIndex: 0,
      neededIndexes: [0, 1, 2],
      prefetchIndexes: [],
    });
  });

  it("loads only the nearest checkpoint window for a multi-hour seek", () => {
    const longSession = Array.from({ length: 480 }, (_, index): SegmentRef => {
      const t0 = 1_000 + index * 30_000;
      return {
        key: `p/project/session/seg-${String(index + 1).padStart(6, "0")}.ors`,
        bytes: 10,
        t0,
        t1: t0 + 29_999,
        batches: 1,
        ...(index % 8 === 0 ? { checkpoints: [{ timestamp: t0, tab: "tab-a", batch: 0 }] } : {}),
      };
    });
    const targetIndex = 470;
    const targetTimestamp = longSession[targetIndex]?.t1 ?? 0;
    const window = chooseSegmentWindow(longSession, targetIndex, {
      targetTimestamp,
      replayTab: "tab-a",
    });

    expect(window.startIndex).toBe(464);
    expect(window.neededIndexes).toEqual([464, 465, 466, 467, 468, 469, 470]);
    expect(window.checkpoint).toEqual({
      timestamp: longSession[464]?.t0,
      tab: "tab-a",
      batch: 0,
      segmentIndex: 464,
    });
  });

  it("uses the first checkpoint tab consistently and validates checkpoint payloads", () => {
    const checkpointSegment: SegmentRef = {
      key: "p/project/session/seg-000001.ors",
      bytes: 10,
      t0: 1_000,
      t1: 2_000,
      batches: 1,
      checkpoints: [{ timestamp: 1_100, tab: "tab-a", batch: 0 }],
    };
    const fullSnapshot = {
      type: EventType.FullSnapshot,
      timestamp: 1_100,
      data: { node: { id: 1, type: 0 }, initialOffset: { left: 0, top: 0 } },
    } as ReplayEvent;
    const meta = {
      type: EventType.Meta,
      timestamp: 1_000,
      data: { href: "https://example.com", width: 1280, height: 720 },
    } as ReplayEvent;
    const viewportResize = {
      type: EventType.IncrementalSnapshot,
      timestamp: 1_050,
      data: { source: IncrementalSource.ViewportResize, width: 1440, height: 900 },
    } as ReplayEvent;
    const later = { type: EventType.Load, timestamp: 1_200, data: {} } as ReplayEvent;
    const batches = [
      {
        index: {
          v: 1 as const,
          s: "session",
          tab: "tab-a",
          seq: 0,
          t0: 1_100,
          t1: 1_200,
          e: [],
          checkpointTimestamps: [1_100],
        },
        events: [fullSnapshot, later],
        decodedBytes: 100,
        segmentBatchIndex: 0,
      },
    ];

    expect(findPrimaryReplayTab([checkpointSegment])).toBe("tab-a");
    expect(() => validateSegmentCheckpoints(checkpointSegment, batches)).not.toThrow();
    expect(eventsFromCheckpoint([meta, viewportResize, fullSnapshot, later], 1_100)).toEqual([
      viewportResize,
      fullSnapshot,
      later,
    ]);
    expect(() =>
      validateSegmentCheckpoints(
        { ...checkpointSegment, checkpoints: [{ timestamp: 1_150, tab: "tab-a", batch: 0 }] },
        batches,
      ),
    ).toThrow("does not match");
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
});
