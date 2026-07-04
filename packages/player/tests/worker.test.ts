import { describe, expect, it, vi } from "vite-plus/test";
import type { ReplayEvent } from "../src/types.ts";
import { installDecodeWorkerEntry } from "../src/worker-entry.ts";
import { DecodeWorkerHost } from "../src/worker-host.ts";

const encoder = new TextEncoder();

describe("decode worker protocol", () => {
  it("round-trips a decode request through a stubbed worker", async () => {
    const worker = makeLinkedWorker();
    const host = new DecodeWorkerHost({
      WorkerCtor: worker.WorkerCtor,
      createObjectUrl: () => "blob:decode-worker",
      revokeObjectUrl: vi.fn(),
    });
    const events = [makeEvent(1_000, "ready")];

    const decoded = await host.decodeBatch(encoder.encode(JSON.stringify(events)));

    expect(decoded).toEqual(events);
    expect(worker.close).not.toHaveBeenCalled();
    host.stop();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("can decode gzip bytes in the worker core", async () => {
    const worker = makeLinkedWorker();
    const host = new DecodeWorkerHost({
      WorkerCtor: worker.WorkerCtor,
      createObjectUrl: () => "blob:decode-worker",
      revokeObjectUrl: vi.fn(),
    });
    const events = [makeEvent(2_000, "gzipped")];

    expect(await host.decodeBatch(await gzipJson(events))).toEqual(events);
  });

  it("rejects pending decodes on timeout and uses a restarted worker next", async () => {
    vi.useFakeTimers();
    try {
      const workers = makeRestartingWorker();
      const host = new DecodeWorkerHost({
        WorkerCtor: workers.WorkerCtor,
        createObjectUrl: () => "blob:decode-worker",
        revokeObjectUrl: vi.fn(),
        timeoutMs: 10,
      });

      const firstDecode = host.decodeBatch(encoder.encode(JSON.stringify([makeEvent(1, "one")])));
      const secondDecode = host.decodeBatch(encoder.encode(JSON.stringify([makeEvent(2, "two")])));
      const firstRejected = expect(firstDecode).rejects.toThrow("Pending decodes were canceled");
      const secondRejected = expect(secondDecode).rejects.toThrow("Pending decodes were canceled");

      await vi.advanceTimersByTimeAsync(10);

      await firstRejected;
      await secondRejected;
      expect(workers.terminate).toHaveBeenCalledTimes(1);

      const nextEvents = [makeEvent(3, "three")];
      await expect(host.decodeBatch(encoder.encode(JSON.stringify(nextEvents)))).resolves.toEqual(
        nextEvents,
      );

      host.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

function makeLinkedWorker(): {
  WorkerCtor: typeof Worker;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const terminate = vi.fn();

  class FakeWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly terminate = terminate;

    constructor() {
      const scope = {
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        postMessage: (message: unknown) => {
          this.onmessage?.({ data: message } as MessageEvent<unknown>);
        },
        close,
      };
      installDecodeWorkerEntry(scope as Parameters<typeof installDecodeWorkerEntry>[0]);
      this.postMessage = (message: unknown) => {
        scope.onmessage?.({ data: message } as MessageEvent<unknown>);
      };
    }

    postMessage(_message: unknown): void {
      /* replaced in constructor */
    }
  }

  return { WorkerCtor: FakeWorker as unknown as typeof Worker, close, terminate };
}

function makeRestartingWorker(): {
  WorkerCtor: typeof Worker;
  terminate: ReturnType<typeof vi.fn>;
} {
  let workerCount = 0;
  const terminate = vi.fn();

  class FakeWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly terminate = terminate;
    private readonly shouldReply: boolean;
    private scope:
      | {
          onmessage: ((event: MessageEvent<unknown>) => void) | null;
        }
      | undefined;

    constructor() {
      workerCount += 1;
      this.shouldReply = workerCount > 1;
      if (!this.shouldReply) {
        return;
      }

      const scope = {
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        postMessage: (message: unknown) => {
          this.onmessage?.({ data: message } as MessageEvent<unknown>);
        },
        close: vi.fn(),
      };
      installDecodeWorkerEntry(scope as Parameters<typeof installDecodeWorkerEntry>[0]);
      this.scope = scope;
    }

    postMessage(message: unknown): void {
      if (!this.shouldReply) {
        return;
      }

      this.scope?.onmessage?.({ data: message } as MessageEvent<unknown>);
    }
  }

  return { WorkerCtor: FakeWorker as unknown as typeof Worker, terminate };
}

async function gzipJson(events: readonly ReplayEvent[]): Promise<Uint8Array> {
  const body = new Response(encoder.encode(JSON.stringify(events))).body;
  if (body === null) {
    throw new Error("test gzip body missing");
  }

  return new Uint8Array(
    await new Response(body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
}

function makeEvent(timestamp: number, name: string): ReplayEvent {
  return { type: 0, timestamp, data: { name } } as ReplayEvent;
}
