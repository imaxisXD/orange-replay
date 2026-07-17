import { describe, expect, it } from "vite-plus/test";
import type { SegmentRef } from "@orange-replay/shared/types";
import { buildSegment, encodeIngestBody } from "@orange-replay/shared/wire";
import { EventType, IncrementalSource } from "rrweb";
import {
  chooseSegmentWindow,
  createReplayHistoryDecodeState,
  decodeReplayHistorySegment,
  decodeSegmentBatches,
  eventsFromCheckpoint,
  findPrimaryReplayTab,
  findSegmentIndex,
  MAX_REPLAY_HISTORY_BATCHES,
  MAX_REPLAY_TAB_DISCOVERY_BATCHES,
  sliceSegmentBatches,
  validateSegmentCheckpoints,
} from "../src/segments.ts";
import type { ReplayEvent } from "../src/types.ts";
import type { DecodeWorkerHost } from "../src/worker-host.ts";

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

  it("bounds legacy live-history decoding while searching for a starting snapshot", async () => {
    const segment = buildSegment([new Uint8Array([1])]);
    const state = createReplayHistoryDecodeState();
    let decodeCalls = 0;
    const worker = {
      decodeBatchWithStats: async () => {
        decodeCalls += 1;
        return { events: [], decodedBytes: 30 * 1024 * 1024 };
      },
    } as unknown as DecodeWorkerHost;

    await decodeReplayHistorySegment(segment, worker, state);
    await decodeReplayHistorySegment(segment, worker, state);
    await expect(decodeReplayHistorySegment(segment, worker, state)).rejects.toThrow(
      "could not find a safe starting snapshot",
    );
    expect(decodeCalls).toBe(3);
  });

  it("bounds retained empty batches even when event and byte totals stay small", async () => {
    const indexedBatch = encodeIngestBody(
      { v: 1, s: "session", tab: "tab-a", seq: 0, t0: 1, t1: 1, e: [] },
      new Uint8Array([1]),
    );
    const fullSegment = buildSegment(
      Array.from({ length: MAX_REPLAY_HISTORY_BATCHES }, () => indexedBatch),
    );
    const overflowSegment = buildSegment([indexedBatch]);
    const state = createReplayHistoryDecodeState("tab-a");
    let decodeCalls = 0;
    const worker = {
      decodeBatchWithStats: async () => {
        decodeCalls += 1;
        return { events: [], decodedBytes: 2 };
      },
    } as unknown as DecodeWorkerHost;

    await decodeReplayHistorySegment(fullSegment, worker, state);
    await expect(decodeReplayHistorySegment(overflowSegment, worker, state)).rejects.toThrow(
      "too many batches",
    );
    expect(decodeCalls).toBe(MAX_REPLAY_HISTORY_BATCHES + 1);
  });

  it("bounds empty legacy batches while discovering the replay tab", async () => {
    const segment = buildSegment(
      Array.from({ length: MAX_REPLAY_TAB_DISCOVERY_BATCHES + 1 }, () => new Uint8Array([1])),
    );
    const state = createReplayHistoryDecodeState();
    let decodeCalls = 0;
    const worker = {
      decodeBatchWithStats: async () => {
        decodeCalls += 1;
        return { events: [], decodedBytes: 2 };
      },
    } as unknown as DecodeWorkerHost;

    await expect(decodeReplayHistorySegment(segment, worker, state)).rejects.toThrow(
      "could not find a safe starting snapshot",
    );
    expect(decodeCalls).toBe(MAX_REPLAY_TAB_DISCOVERY_BATCHES + 1);
  });

  it("keeps the earliest indexed snapshot tab when checkpoint metadata is absent", async () => {
    const laterSnapshot = {
      type: EventType.FullSnapshot,
      timestamp: 2_000,
      data: {
        node: { id: 1, type: 0, childNodes: [] },
        initialOffset: { left: 0, top: 0 },
      },
    } as ReplayEvent;
    const earlierSnapshot = {
      type: EventType.FullSnapshot,
      timestamp: 1_000,
      data: {
        node: { id: 2, type: 0, childNodes: [] },
        initialOffset: { left: 0, top: 0 },
      },
    } as ReplayEvent;
    const segment = buildSegment([
      encodeIngestBody(
        { v: 1, s: "session", tab: "tab-later", seq: 0, t0: 2_000, t1: 2_000, e: [] },
        new Uint8Array([1]),
      ),
      encodeIngestBody(
        { v: 1, s: "session", tab: "tab-earlier", seq: 0, t0: 1_000, t1: 1_000, e: [] },
        new Uint8Array([2]),
      ),
    ]);
    const decodedPayloads: number[] = [];
    const worker = {
      decodeBatchWithStats: async (payload: Uint8Array) => {
        decodedPayloads.push(payload[0] ?? -1);
        return {
          events: payload[0] === 1 ? [laterSnapshot] : [earlierSnapshot],
          decodedBytes: 10,
        };
      },
    } as unknown as DecodeWorkerHost;
    const state = createReplayHistoryDecodeState();

    const decoded = await decodeReplayHistorySegment(segment, worker, state);

    expect(state.activeTab).toBe("tab-earlier");
    expect(decodedPayloads).toEqual([2]);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.segmentBatchIndex).toBe(1);
  });

  it("rejects decoded event times outside the server-clamped batch envelope", async () => {
    const segment = buildSegment([
      encodeIngestBody(
        { v: 1, s: "session", tab: "tab-a", seq: 0, t0: 1_000, t1: 1_000, e: [] },
        new Uint8Array([1]),
      ),
    ]);
    const worker = {
      decodeBatchWithStats: async () => ({
        events: [{ type: EventType.Load, timestamp: 10_000, data: {} } as ReplayEvent],
        decodedBytes: 10,
      }),
    } as unknown as DecodeWorkerHost;

    await expect(decodeSegmentBatches(segment, worker)).rejects.toMatchObject({
      name: "ReplayDataError",
    });
    await expect(
      decodeReplayHistorySegment(segment, worker, createReplayHistoryDecodeState("tab-a")),
    ).rejects.toMatchObject({ name: "ReplayDataError" });
  });

  it("rejects legacy event times outside the trusted segment envelope", async () => {
    const segmentBytes = buildSegment([new Uint8Array([1])]);
    const trustedSegment: SegmentRef = {
      key: "p/project/session/seg-000001.ors",
      bytes: segmentBytes.byteLength,
      t0: 1_000,
      t1: 2_000,
      batches: 1,
    };
    const worker = {
      decodeBatchWithStats: async () => ({
        events: [{ type: EventType.Load, timestamp: 10_000, data: {} } as ReplayEvent],
        decodedBytes: 10,
      }),
    } as unknown as DecodeWorkerHost;

    await expect(decodeSegmentBatches(segmentBytes, worker, trustedSegment)).rejects.toMatchObject({
      name: "ReplayDataError",
    });
    await expect(
      decodeReplayHistorySegment(
        segmentBytes,
        worker,
        createReplayHistoryDecodeState("legacy"),
        trustedSegment,
      ),
    ).rejects.toMatchObject({ name: "ReplayDataError" });
  });

  it("accepts a long legacy gap when both events remain inside the trusted segment", async () => {
    const start = 1_000;
    const end = start + 12 * 60 * 60_000;
    const segmentBytes = buildSegment([new Uint8Array([1]), new Uint8Array([2])]);
    const trustedSegment: SegmentRef = {
      key: "p/project/session/seg-000001.ors",
      bytes: segmentBytes.byteLength,
      t0: start,
      t1: end,
      batches: 2,
    };
    const worker = {
      decodeBatchWithStats: async (payload: Uint8Array) => ({
        events: [
          {
            type: EventType.Load,
            timestamp: payload[0] === 1 ? start : end,
            data: {},
          } as ReplayEvent,
        ],
        decodedBytes: 10,
      }),
    } as unknown as DecodeWorkerHost;

    const recordedBatches = await decodeSegmentBatches(segmentBytes, worker, trustedSegment);
    const liveBatches = await decodeReplayHistorySegment(
      segmentBytes,
      worker,
      createReplayHistoryDecodeState("legacy"),
      trustedSegment,
    );

    expect(
      recordedBatches.flatMap((batch) => batch.events.map((event) => event.timestamp)),
    ).toEqual([start, end]);
    expect(liveBatches.flatMap((batch) => batch.events.map((event) => event.timestamp))).toEqual([
      start,
      end,
    ]);
  });
});
