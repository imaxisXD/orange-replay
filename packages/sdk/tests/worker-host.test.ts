import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkerHost } from "../src/pipeline/worker-host.ts";
import type { eventWithTime } from "@orange-replay/rrweb-fork";

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  fail(error: Error): void {
    this.onerror?.({ error } as ErrorEvent);
  }
}

const decoder = new TextDecoder();

afterEach(() => {
  FakeWorker.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WorkerHost", () => {
  it("falls back to inline serialization when the worker fails after startup", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const warn = vi.fn();
    const revokeObjectUrl = vi.fn();
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl,
      warn,
    });
    const event = makeEvent(1, "before-error");

    host.addEvents([event]);
    const flush = host.flushBatch({ eventCount: 1 });
    FakeWorker.instances[0]?.fail(new Error("CSP blocked worker"));
    const result = await flush;

    expect(host.isDegraded()).toBe(true);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:orange-replay-worker");
    expect(JSON.parse(decoder.decode(result.payload))).toEqual([event]);
    expect(result.uncompressed).toBe(true);
  });

  it("times out a silent worker flush and switches future work to inline mode", async () => {
    vi.useFakeTimers();
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
      flushTimeoutMs: 5,
    });

    host.addEvents([makeEvent(1, "silent")]);
    const flush = host.flushBatch({ eventCount: 1 });
    const expectedRejection = expect(flush).rejects.toThrow(
      "Orange Replay worker flush timed out.",
    );
    await vi.advanceTimersByTimeAsync(5);

    await expectedRejection;
    expect(host.isDegraded()).toBe(true);
  });

  it("does not transfer ArrayBuffers away from the main-thread copy", () => {
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
    });
    const buffer = new ArrayBuffer(8);

    host.addEvents([
      {
        type: 0,
        timestamp: 1,
        data: { buffer },
      } as unknown as eventWithTime,
    ]);

    expect(FakeWorker.instances[0]?.postMessage).toHaveBeenCalledWith({
      type: "add",
      events: [{ type: 0, timestamp: 1, data: { buffer } }],
    });
    expect(buffer.byteLength).toBe(8);
  });
});

function makeEvent(timestamp: number, name: string): eventWithTime {
  return { type: 0, timestamp, data: { name } } as eventWithTime;
}
