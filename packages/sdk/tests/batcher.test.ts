import { describe, expect, it } from "vite-plus/test";
import { SDK_FLUSH_LIVE_MS } from "@orange-replay/shared/constants";
import { EventType, IncrementalSource, type eventWithTime } from "@orange-replay/rrweb-fork";
import { Batcher, estimateRrwebEventBytes } from "../src/pipeline/batcher.ts";

describe("Batcher", () => {
  it("retunes the timer from ingest ack flushMs and tightens for live sessions", () => {
    const batcher = new Batcher({ flushMs: 15_000 });

    batcher.retuneFromAck({ ok: true, live: false, flushMs: 8_000 });
    expect(batcher.getFlushMs()).toBe(8_000);

    batcher.retuneFromAck({ ok: true, live: true, flushMs: 15_000 });
    expect(batcher.getFlushMs()).toBe(SDK_FLUSH_LIVE_MS);
  });

  it("requests a flush when the raw byte threshold is crossed", () => {
    const batcher = new Batcher({ rawFlushBytes: 100 });

    expect(batcher.addEstimatedBytes(60).shouldFlush).toBe(false);
    expect(batcher.addEstimatedBytes(41).shouldFlush).toBe(true);
  });

  it("keeps a running raw byte total across takes and resets", () => {
    const batcher = new Batcher();
    batcher.addEstimatedBytes(10);
    batcher.addEstimatedBytes(20);
    batcher.addEstimatedBytes(30);

    expect(batcher.currentRawBytes()).toBe(60);
    expect(batcher.takeBatch(2)).toMatchObject({ eventCount: 2, rawBytes: 30 });
    expect(batcher.currentRawBytes()).toBe(30);

    batcher.reset();
    expect(batcher.currentRawBytes()).toBe(0);
  });

  it("splits pagehide batches under the keepalive raw byte target", () => {
    const batcher = new Batcher({ pagehideRawFlushBytes: 60 });
    batcher.addEstimatedBytes(30);
    batcher.addEstimatedBytes(25);
    batcher.addEstimatedBytes(20);
    batcher.addEstimatedBytes(50);

    expect(batcher.pagehideChunkCounts()).toEqual([2, 1, 1]);
  });

  it("takes the newest pagehide slice that fits and drops older events", () => {
    const batcher = new Batcher({ pagehideRawFlushBytes: 60 });
    batcher.addEstimatedBytes(50);
    batcher.addEstimatedBytes(25);
    batcher.addEstimatedBytes(20);

    expect(batcher.takeNewestPagehideBatch()).toEqual({
      startIndex: 1,
      eventCount: 2,
      rawBytes: 45,
      droppedCount: 1,
      droppedRawBytes: 50,
      totalRawBytes: 95,
    });
    expect(batcher.eventCount()).toBe(0);
  });

  it("counts sealed image bytes in canvas frames", () => {
    const event = {
      type: EventType.IncrementalSnapshot,
      timestamp: 1,
      data: {
        source: IncrementalSource.CanvasMutation,
        commands: [
          { property: "clearRect", args: [0, 0, 1, 1] },
          {
            property: "drawImage",
            args: [{ args: [{ data: [{ base64: "A".repeat(8_000) }] }] }],
          },
        ],
      },
    } as unknown as eventWithTime;

    expect(estimateRrwebEventBytes(event)).toBe(9_024);
  });
});
