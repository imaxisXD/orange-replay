import { describe, expect, it } from "vite-plus/test";
import type { BatchIndex, LiveSessionSnapshot } from "@orange-replay/shared/types";
import { applyLiveIndexToSnapshot } from "../src/live-metadata.ts";
import { parseLiveHelloMessage } from "../src/live.ts";

describe("live session metadata", () => {
  it("reads the counter snapshot from the live hello message", () => {
    const snapshot = makeSnapshot();
    const hello = parseLiveHelloMessage(
      JSON.stringify({
        type: "hello",
        sessionId: "session-live",
        startedAt: snapshot.startedAt,
        segments: [],
        pendingBatches: 1,
        snapshot,
      }),
    );

    expect(hello?.snapshot).toEqual(snapshot);
    expect(parseLiveHelloMessage("not json")).toBeNull();
  });

  it("updates clicks, errors, duration, and rage clicks from live batch indexes", () => {
    let snapshot = makeSnapshot();
    const clicks = [1_100, 1_200, 1_300];

    for (const [seq, time] of clicks.entries()) {
      snapshot = applyLiveIndexToSnapshot(
        snapshot,
        makeIndex(seq, time, [
          { t: time, k: "click", d: "button", m: { x: 0.5, y: 0.5, w: 100, h: 100 } },
        ]),
      );
    }
    snapshot = applyLiveIndexToSnapshot(
      snapshot,
      makeIndex(3, 1_500, [{ t: 1_500, k: "error", d: "Uncaught Error: test" }]),
    );

    expect(snapshot.counts).toEqual({
      batches: 4,
      events: 5,
      clicks: 3,
      errors: 1,
      rages: 1,
      navs: 0,
    });
    expect(snapshot.durationMs).toBe(550);
    expect(snapshot.timeline.map((event) => event.k)).toEqual([
      "click",
      "click",
      "click",
      "rage",
      "error",
    ]);
  });
});

function makeSnapshot(): LiveSessionSnapshot {
  return {
    startedAt: 1_000,
    endedAt: 1_000,
    durationMs: 0,
    timeline: [],
    counts: { batches: 0, events: 0, clicks: 0, errors: 0, rages: 0, navs: 0 },
  };
}

function makeIndex(seq: number, time: number, events: BatchIndex["e"]): BatchIndex {
  return {
    v: 1,
    s: "session-live",
    tab: "tab-live",
    seq,
    t0: time,
    t1: time + 50,
    e: events,
  };
}
