import { describe, expect, it } from "vite-plus/test";
import { EventType, IncrementalSource, type eventWithTime } from "@orange-replay/rrweb-fork";
import {
  BackpressureController,
  eventDropTier,
  trimBufferedEvents,
} from "../src/pipeline/backpressure.ts";

describe("backpressure", () => {
  it("classifies mouse events before scroll and keeps mutations", () => {
    expect(eventDropTier(mouseMoveEvent())).toBe("mouse");
    expect(eventDropTier(scrollEvent())).toBe("scroll");
    expect(eventDropTier(mutationEvent())).toBe("keep");
    expect(eventDropTier(fullSnapshotEvent())).toBe("keep");
  });

  it("drops mouse events before scroll and never drops mutations", () => {
    const result = trimBufferedEvents(
      [
        { value: "mousemove", bytes: 50, tier: "mouse" },
        { value: "scroll", bytes: 50, tier: "scroll" },
        { value: "mutation", bytes: 50, tier: "keep" },
      ],
      80,
    );

    expect(result.dropped.map((event) => event.value)).toEqual(["mousemove", "scroll"]);
    expect(result.kept.map((event) => event.value)).toEqual(["mutation"]);
    expect(result.bytes).toBe(50);
  });

  it("enforces the buffered cap for low-value events but accepts mutation data", () => {
    const pressure = new BackpressureController(100);
    pressure.addPendingBytes(90);

    expect(pressure.canAccept(mouseMoveEvent(), 20).accept).toBe(false);
    expect(pressure.canAccept(scrollEvent(), 20).accept).toBe(false);
    expect(pressure.canAccept(mutationEvent(), 20).accept).toBe(true);
    expect(pressure.droppedCount()).toBe(2);
  });
});

function mouseMoveEvent(): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: { source: IncrementalSource.MouseMove, positions: [] },
  } as eventWithTime;
}

function scrollEvent(): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: { source: IncrementalSource.Scroll, id: 1, x: 0, y: 10 },
  } as eventWithTime;
}

function mutationEvent(): eventWithTime {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp: 1,
    data: { source: IncrementalSource.Mutation, adds: [], removes: [], texts: [], attributes: [] },
  } as eventWithTime;
}

function fullSnapshotEvent(): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp: 1,
    data: { node: { type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
  } as unknown as eventWithTime;
}
