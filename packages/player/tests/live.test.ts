import { describe, expect, it } from "vite-plus/test";
import type { BatchIndex } from "@orange-replay/shared/types";
import { encodeIngestBody } from "@orange-replay/shared/wire";
import {
  acceptLiveFrame,
  createLiveFrameState,
  decodeLiveFrame,
  orderLiveFrames,
} from "../src/live.ts";

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
    expect(state.frames).toHaveLength(1);
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
