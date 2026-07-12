// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { SDK_FLUSH_LIVE_MS } from "@orange-replay/shared/constants";
import {
  EventType,
  getSnapshotEstimatedBytes,
  IncrementalSource,
  Mirror,
  type eventWithTime,
} from "@orange-replay/rrweb-fork";
import { snapshotInChunks } from "../../rrweb-fork/src/vendor/rrweb-snapshot/index.ts";
import {
  BATCH_RAW_FLUSH_BYTES,
  Batcher,
  estimateRrwebEventBytes,
} from "../src/pipeline/batcher.ts";

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

  it("keeps the configured pagehide byte target", () => {
    const batcher = new Batcher({ pagehideRawFlushBytes: 60 });
    expect(batcher.getPagehideRawFlushBytes()).toBe(60);
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

    expect(estimateRrwebEventBytes(event)).toBe(17_026);
  });

  it("counts sealed image bytes in normal mutation attributes", () => {
    const source = `data:image/webp;base64,${"A".repeat(200_000)}`;
    const event = {
      type: EventType.IncrementalSnapshot,
      timestamp: 1,
      data: {
        source: IncrementalSource.Mutation,
        adds: [],
        removes: [],
        texts: [],
        attributes: [{ id: 8, attributes: { src: source, srcset: null } }],
      },
    } as eventWithTime;

    expect(estimateRrwebEventBytes(event)).toBeGreaterThan(source.length);
  });

  it("estimates full snapshots without stringifying the DOM tree", () => {
    const event = {
      type: EventType.FullSnapshot,
      timestamp: 1,
      data: {
        node: { type: 0, id: 1, childNodes: [] },
        initialOffset: { top: 0, left: 0 },
      },
    } as eventWithTime;
    const stringify = vi.spyOn(JSON, "stringify");

    const bytes = estimateRrwebEventBytes(event);

    expect(bytes).toBe(BATCH_RAW_FLUSH_BYTES);
    expect(stringify).not.toHaveBeenCalled();
  });

  it("uses the recorder's incremental estimate for full and iframe snapshots", async () => {
    document.body.innerHTML = "<main><p>small snapshot</p></main>";
    const node = await snapshotInChunks(
      document,
      { mirror: new Mirror() },
      { skipPreparation: true },
    );
    expect(node).not.toBeNull();
    const estimatedBytes = getSnapshotEstimatedBytes(node!);
    expect(estimatedBytes).toBeGreaterThan(0);
    expect(estimatedBytes).toBeLessThan(BATCH_RAW_FLUSH_BYTES);

    const fullSnapshot = {
      type: EventType.FullSnapshot,
      timestamp: 1,
      data: { node, initialOffset: { top: 0, left: 0 } },
    } as eventWithTime;
    const iframeSnapshot = {
      type: EventType.IncrementalSnapshot,
      timestamp: 2,
      data: {
        source: IncrementalSource.Mutation,
        adds: [{ parentId: 9, nextId: null, node }],
        removes: [],
        texts: [],
        attributes: [],
        isAttachIframe: true,
      },
    } as eventWithTime;

    expect(estimateRrwebEventBytes(fullSnapshot)).toBe(estimatedBytes);
    expect(estimateRrwebEventBytes(iframeSnapshot)).toBe(estimatedBytes);
  });
});
