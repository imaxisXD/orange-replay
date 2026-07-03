import { describe, expect, it } from "vite-plus/test";
import { SDK_FLUSH_LIVE_MS } from "@orange-replay/shared/constants";
import { Batcher } from "../src/pipeline/batcher.ts";

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

  it("splits pagehide batches under the keepalive raw byte target", () => {
    const batcher = new Batcher({ pagehideRawFlushBytes: 60 });
    batcher.addEstimatedBytes(30);
    batcher.addEstimatedBytes(25);
    batcher.addEstimatedBytes(20);
    batcher.addEstimatedBytes(50);

    expect(batcher.pagehideChunkCounts()).toEqual([2, 1, 1]);
  });
});
