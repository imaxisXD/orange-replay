import { describe, expect, it, vi } from "vite-plus/test";
import type { ReplayEvent } from "../src/types.ts";
import { installDecodeWorkerEntry, makeDecodeWorkerSource } from "../src/worker-entry.ts";
import {
  decodeBatchBytes,
  decodeBatchWithStats,
  MAX_DECODED_BATCH_BYTES,
  MAX_DECODED_BATCH_EVENTS,
  MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS,
} from "../src/worker-core.ts";
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

  it("returns the real decoded byte count", async () => {
    const events = [makeEvent(2_100, "stats")];
    const payload = encoder.encode(JSON.stringify(events));

    await expect(decodeBatchWithStats(payload)).resolves.toEqual({
      decodedBytes: payload.byteLength,
      events,
    });
  });

  it("rejects replay batches that decode to too many bytes", async () => {
    await expect(decodeBatchBytes(new Uint8Array(MAX_DECODED_BATCH_BYTES + 1))).rejects.toThrow(
      "Replay batch is too large after decoding.",
    );
  });

  it("rejects gzip replay batches that expand too much", async () => {
    const payload = await gzipBytes(new Uint8Array(MAX_DECODED_BATCH_BYTES + 1).fill(32));

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch is too large after decoding.",
    );
  });

  it("rejects replay batches padded with too much trailing whitespace", async () => {
    const payload = encoder.encode(
      `${JSON.stringify([makeEvent(2_200, "padding")])}${" ".repeat(
        MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS + 1,
      )}`,
    );

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch JSON has too much trailing whitespace.",
    );
  });

  it("rejects replay events with an unknown event type", async () => {
    const payload = encoder.encode(JSON.stringify([{ type: 99, timestamp: 1, data: {} }]));

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch contains an invalid replay event type.",
    );
  });

  it("rejects full snapshots without a valid root node", async () => {
    const payload = encoder.encode(JSON.stringify([{ type: 2, timestamp: 1, data: {} }]));

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch contains an invalid full snapshot.",
    );
  });

  it("rejects full snapshots with malformed child node trees", async () => {
    const payload = encoder.encode(
      JSON.stringify([{ type: 2, timestamp: 1, data: { node: { id: 1, type: 0 } } }]),
    );

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch contains an invalid full snapshot node.",
    );
  });

  it("rejects text nodes that carry element fields", async () => {
    const payload = encoder.encode(
      JSON.stringify([
        {
          type: 2,
          timestamp: 1,
          data: {
            node: {
              id: 1,
              type: 2,
              tagName: "style",
              attributes: {},
              childNodes: [
                {
                  id: 2,
                  type: 3,
                  tagName: "div",
                  textContent: '@import "https://internal.example/a.css";',
                },
              ],
            },
          },
        },
      ]),
    );

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch contains an invalid full snapshot node.",
    );
  });

  it("rejects meta events without viewport fields", async () => {
    const payload = encoder.encode(
      JSON.stringify([{ type: 4, timestamp: 1, data: { href: "/" } }]),
    );

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch contains invalid meta data.",
    );
  });

  it("rejects malformed mutation events", async () => {
    const payload = encoder.encode(
      JSON.stringify([{ type: 3, timestamp: 1, data: { source: 0, texts: [] } }]),
    );

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch contains invalid mutation data.",
    );
  });

  it("rejects mutation adds with malformed child node trees", async () => {
    const payload = encoder.encode(
      JSON.stringify([
        {
          type: 3,
          timestamp: 1,
          data: {
            source: 0,
            texts: [],
            attributes: [],
            removes: [],
            adds: [{ parentId: 1, node: { id: 2, type: 2, tagName: "div", attributes: {} } }],
          },
        },
      ]),
    );

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch contains invalid mutation data.",
    );
  });

  it("rejects replay event arrays before queueing an oversized shape", async () => {
    const payload = encoder.encode(
      JSON.stringify([
        {
          type: 3,
          timestamp: 1,
          data: {
            source: 1,
            positions: Array.from({ length: 10_001 }, () => ({ x: 1, y: 1, id: 1, timeOffset: 0 })),
          },
        },
      ]),
    );

    await expect(decodeBatchBytes(payload)).rejects.toThrow(
      "Replay batch contains invalid mutation data.",
    );
  });

  it("keeps the generated inline worker source on the same validation path", () => {
    const source = makeDecodeWorkerSource();

    expect(source).toContain("validateFullSnapshotData");
    expect(source).toContain("validateSnapshotAttributes");
    expect(source).toContain("MAX_REPLAY_EVENT_ARRAY_ITEMS");
    expect(source).toContain("MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS");
    expect(source).toContain("validateTextLikeNode");
    expect(source).toContain("decodedBytes");
    expect(source).toContain("Replay batch contains an invalid full snapshot.");
  });

  it("rejects replay batches with too many events", async () => {
    const events = Array.from({ length: MAX_DECODED_BATCH_EVENTS + 1 }, (_, index) =>
      makeEvent(index, "many"),
    );

    await expect(decodeBatchBytes(encoder.encode(JSON.stringify(events)))).rejects.toThrow(
      "Replay batch has too many events.",
    );
  });

  it("accepts realistic DOM nesting but rejects pathological depth", async () => {
    // rrweb serializes ~2 JSON levels per DOM level; real pages reach DOM depth
    // 30-60, so depths around 100 must decode (the 40 cap rejected our own
    // landing page's full snapshot at depth 42).
    const deepEvent = (levels: number): ReplayEvent => {
      const event = makeEvent(1, "deep") as ReplayEvent & { data: unknown };
      let data: unknown = {};
      for (let index = 0; index < levels; index += 1) {
        data = { child: data };
      }
      event.data = data;
      return event;
    };

    const accepted = await decodeBatchBytes(encoder.encode(JSON.stringify([deepEvent(100)])));
    expect(accepted).toHaveLength(1);

    await expect(
      decodeBatchBytes(encoder.encode(JSON.stringify([deepEvent(135)]))),
    ).rejects.toThrow("Replay event is too deeply nested.");
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
  return gzipBytes(encoder.encode(JSON.stringify(events)));
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const body = new Response(bytes as unknown as BodyInit).body;
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
