import { describe, expect, it } from "vite-plus/test";
import type { BatchIndex } from "@orange-replay/shared/types";
import { encodeIngestBody } from "@orange-replay/shared/wire";
import {
  acceptLiveEventsAfterKeyframe,
  acceptLiveFrame,
  createLiveKeyframeBuffer,
  createLiveFrameState,
  decodeLiveFrame,
  orderLiveFrames,
  startWaitingForKeyframe,
} from "../src/live.ts";
import { EventType, IncrementalSource, type eventWithTime } from "rrweb";

describe("live frame handling", () => {
  it("decodes shared ingest bodies into live frames", () => {
    const index = makeIndex("tab-a", 1, 1_000);
    const frame = decodeLiveFrame(encodeIngestBody(index, new Uint8Array([1, 2, 3])));

    expect(frame.index).toEqual(index);
    expect(Array.from(frame.payload)).toEqual([1, 2, 3]);
  });

  it("orders frames by tab and seq while tolerating duplicates", () => {
    const frames = [
      { index: makeIndex("tab-b", 2, 3_000), payload: new Uint8Array([4]) },
      { index: makeIndex("tab-a", 2, 2_000), payload: new Uint8Array([2]) },
      { index: makeIndex("tab-a", 1, 1_000), payload: new Uint8Array([1]) },
      { index: makeIndex("tab-a", 1, 1_000), payload: new Uint8Array([1]) },
    ];

    expect(orderLiveFrames(frames).map((frame) => `${frame.index.tab}:${frame.index.seq}`)).toEqual(
      ["tab-a:1", "tab-a:2", "tab-b:2"],
    );
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
