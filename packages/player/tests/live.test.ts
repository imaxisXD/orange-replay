import { describe, expect, it } from "vite-plus/test";
import type { BatchIndex } from "@orange-replay/shared/types";
import { encodeIngestBody } from "@orange-replay/shared/wire";
import {
  acceptLiveEventsAfterKeyframe,
  acceptLiveEventBatchAfterKeyframeWithStatus,
  acceptLiveEventsAfterKeyframeWithStatus,
  acceptLiveFrame,
  createLiveKeyframeBuffer,
  createLiveFrameState,
  decodeLiveFrame,
  retainLiveReplayEvents,
  startWaitingForKeyframe,
} from "../src/live.ts";
import { EventType, IncrementalSource, type eventWithTime } from "rrweb";

describe("live frame handling", () => {
  it("decodes shared ingest bodies into live frames", () => {
    const index = makeIndex("tab-a", 1, 1_000);
    const encoded = encodeIngestBody(index, new Uint8Array([1, 2, 3]));
    const frame = decodeLiveFrame(encoded);

    expect(frame.index).toEqual(index);
    expect(Array.from(frame.payload)).toEqual([1, 2, 3]);
    expect(frame.encodedByteLength).toBe(encoded.byteLength);
  });

  it("keeps duplicate live frames out of state", () => {
    const state = createLiveFrameState();
    const frame = encodeIngestBody(makeIndex("tab-a", 7, 1_000), new Uint8Array([9]));

    expect(acceptLiveFrame(state, frame)).not.toBeNull();
    expect(acceptLiveFrame(state, frame)).toBeNull();
    expect(state.seen.size).toBe(1);
  });

  it("keeps only recent live frame keys for dedupe", () => {
    const state = createLiveFrameState();

    for (let seq = 0; seq < 4_100; seq += 1) {
      acceptLiveFrame(
        state,
        encodeIngestBody(makeIndex("tab-a", seq, seq), new Uint8Array([seq % 255])),
      );
    }

    expect(state.seen.size).toBe(4_096);
    expect(state.seen.has("tab-a:0")).toBe(false);
    expect(state.seen.has("tab-a:4099")).toBe(true);
  });

  it("waits for a full snapshot before accepting live replay events", () => {
    const buffer = createLiveKeyframeBuffer();
    startWaitingForKeyframe(buffer);

    expect(acceptLiveEventsAfterKeyframe(buffer, [incrementalEvent(1)])).toEqual([]);
    expect(buffer.waiting).toBe(true);
    expect(buffer.started).toBe(false);

    const meta = metaEvent(2);
    const snapshot = fullSnapshotEvent(3);
    const tail = incrementalEvent(4);
    expect(acceptLiveEventsAfterKeyframe(buffer, [meta, snapshot, tail])).toEqual([
      meta,
      snapshot,
      tail,
    ]);
    expect(buffer.waiting).toBe(false);
    expect(buffer.started).toBe(true);
  });

  it("resets the pre-keyframe buffer when live events exceed the cap", () => {
    const buffer = createLiveKeyframeBuffer();
    startWaitingForKeyframe(buffer, 1_000);

    const result = acceptLiveEventsAfterKeyframeWithStatus(
      buffer,
      [incrementalEvent(1), incrementalEvent(2)],
      { maxEvents: 1, now: 1_001 },
    );

    expect(result).toEqual({ events: [], status: "overflow" });
    expect(buffer.waiting).toBe(true);
    expect(buffer.started).toBe(false);
    expect(buffer.events).toEqual([]);
  });

  it("orders buffered live batches by tab and seq before accepting the keyframe", () => {
    const buffer = createLiveKeyframeBuffer();
    startWaitingForKeyframe(buffer);

    const meta = metaEvent(2);
    const snapshot = fullSnapshotEvent(3);
    const tail = incrementalEvent(4);

    expect(
      acceptLiveEventBatchAfterKeyframeWithStatus(buffer, {
        tab: "tab-a",
        seq: 2,
        events: [tail],
      }),
    ).toEqual({ events: [], status: "waiting" });

    expect(
      acceptLiveEventBatchAfterKeyframeWithStatus(buffer, {
        tab: "tab-a",
        seq: 1,
        events: [meta, snapshot],
      }),
    ).toEqual({ events: [meta, snapshot, tail], status: "accepted" });
    expect(buffer.waiting).toBe(false);
    expect(buffer.started).toBe(true);
  });

  it("keeps every mutation after the live rebuild snapshot", () => {
    const oldSnapshot = fullSnapshotEvent(1_000);
    const oldMutation = incrementalEvent(2_000);
    const meta = metaEvent(5_000);
    const snapshot = fullSnapshotEvent(5_001);
    const requiredMutation = incrementalEvent(6_000);
    const recentMutation = incrementalEvent(11_000);

    expect(
      retainLiveReplayEvents(
        [oldSnapshot, oldMutation, meta, snapshot, requiredMutation, recentMutation],
        10_000,
      ),
    ).toEqual([meta, snapshot, requiredMutation, recentMutation]);
  });
});

function makeIndex(tab: string, seq: number, time: number): BatchIndex {
  return {
    v: 1,
    s: "session",
    tab,
    seq,
    t0: time,
    t1: time,
    e: [{ t: time, k: "click" }],
  };
}

function metaEvent(timestamp: number): eventWithTime {
  return {
    type: EventType.Meta,
    timestamp,
    data: { href: "https://example.com", width: 1280, height: 720 },
  } as eventWithTime;
}

function fullSnapshotEvent(timestamp: number): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp,
    data: { node: { id: 1, type: 0 }, initialOffset: { left: 0, top: 0 } },
  } as eventWithTime;
}

function incrementalEvent(timestamp: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp,
    data: { source: IncrementalSource.Mutation, texts: [], attributes: [], removes: [], adds: [] },
  } as eventWithTime;
}
