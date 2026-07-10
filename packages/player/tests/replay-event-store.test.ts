import { EventType, IncrementalSource, type eventWithTime } from "rrweb";
import { describe, expect, it } from "vite-plus/test";
import { ReplayEventStore } from "../src/player/replay-event-store.ts";

describe("recorded replay event rebasing", () => {
  it("drops events before a later full-snapshot checkpoint", () => {
    const store = new ReplayEventStore();
    store.resetRecordedEvents("tab-a");
    store.add([fullSnapshot(1_000), mutation(1_100), fullSnapshot(2_000), mutation(2_100)]);

    expect(store.rebaseAtCheckpoint(2_000)).toBe(true);
    expect(store.events.map((event) => event.timestamp)).toEqual([2_000, 2_100]);
    expect(store.rebaseAtCheckpoint(3_000)).toBe(false);
    expect(store.events.map((event) => event.timestamp)).toEqual([2_000, 2_100]);
  });
});

function fullSnapshot(timestamp: number): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp,
    data: { node: { id: 1, type: 0 }, initialOffset: { left: 0, top: 0 } },
  } as eventWithTime;
}

function mutation(timestamp: number): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp,
    data: { source: IncrementalSource.Mutation, texts: [], attributes: [], removes: [], adds: [] },
  } as eventWithTime;
}
