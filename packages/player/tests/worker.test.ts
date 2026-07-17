import { describe, expect, it, vi } from "vite-plus/test";
import { runInNewContext } from "node:vm";
import { EventType, IncrementalSource } from "rrweb";
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

  it("does not accept new decode work after the player stops it", async () => {
    const host = new DecodeWorkerHost({ allowSynchronousFallback: true });
    host.stop();

    await expect(host.decodeBatch(encoder.encode("[]"))).rejects.toThrow("Replay worker stopped.");
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

  it.each([
    [
      "far-future timestamp",
      { type: EventType.Load, timestamp: Date.now() + 10 * 60_000, data: {} },
    ],
    [
      "unsafe stored delay",
      { type: EventType.Load, timestamp: 1, delay: 2 * 24 * 60 * 60_000, data: {} },
    ],
  ])("rejects a replay event with an unsafe %s", async (_name, event) => {
    const payload = encoder.encode(JSON.stringify([event]));

    await expect(decodeBatchBytes(payload)).rejects.toMatchObject({ name: "ReplayDataError" });
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
      "Replay batch contains invalid incremental replay data.",
    );
  });

  it.each([
    ["empty mouse movement", { source: IncrementalSource.MouseMove, positions: [] }],
    [
      "incomplete touch movement",
      { source: IncrementalSource.TouchMove, positions: [{ x: 1, y: 2, id: 1 }] },
    ],
    ["incomplete drag movement", { source: IncrementalSource.Drag, positions: [{}] }],
    [
      "far-future mouse movement",
      {
        source: IncrementalSource.MouseMove,
        positions: [{ x: 1, y: 2, id: 1, timeOffset: 2_000 }],
      },
    ],
    [
      "stale touch movement",
      {
        source: IncrementalSource.TouchMove,
        positions: [{ x: 1, y: 2, id: 1, timeOffset: -10 * 60_000 }],
      },
    ],
    [
      "out-of-order drag movement",
      {
        source: IncrementalSource.Drag,
        positions: [
          { x: 1, y: 2, id: 1, timeOffset: -10 },
          { x: 2, y: 3, id: 1, timeOffset: -2_000 },
        ],
      },
    ],
    ["missing mouse interaction type", { source: IncrementalSource.MouseInteraction, id: 1 }],
    ["missing scroll coordinates", { source: IncrementalSource.Scroll, id: 1 }],
    ["missing input value", { source: IncrementalSource.Input, id: 1 }],
    ["missing media action", { source: IncrementalSource.MediaInteraction, id: 1 }],
    [
      "invalid stylesheet rule",
      { source: IncrementalSource.StyleSheetRule, id: 1, adds: [{ rule: 3 }] },
    ],
    [
      "invalid canvas commands",
      { source: IncrementalSource.CanvasMutation, id: 1, type: 0, commands: "clearRect" },
    ],
    ["missing font source", { source: IncrementalSource.Font, family: "Inter", buffer: false }],
    ["unsupported log event", { source: IncrementalSource.Log, payload: [] }],
    [
      "invalid style declaration path",
      { source: IncrementalSource.StyleDeclaration, id: 1, index: [Number.NaN] },
    ],
    [
      "invalid selection range",
      { source: IncrementalSource.Selection, ranges: [{ start: 1, end: 1 }] },
    ],
    [
      "invalid adopted stylesheet IDs",
      { source: IncrementalSource.AdoptedStyleSheet, id: 1, styleIds: ["private"] },
    ],
    [
      "invalid custom element name",
      { source: IncrementalSource.CustomElement, define: { name: 42 } },
    ],
  ])("rejects %s before it reaches rrweb", async (_name, data) => {
    const payload = encoder.encode(
      JSON.stringify([{ type: EventType.IncrementalSnapshot, timestamp: 1, data }]),
    );

    await expect(decodeBatchBytes(payload)).rejects.toThrow("invalid incremental replay data");
  });

  it.each(validIncrementalFixtures())("accepts valid %s replay data", async (_name, data) => {
    const event = { type: EventType.IncrementalSnapshot, timestamp: 1, data };
    const payload = encoder.encode(JSON.stringify([event]));

    await expect(decodeBatchBytes(payload)).resolves.toEqual([event]);
  });

  it("uses the same semantic movement bounds inside the generated inline worker", async () => {
    const payload = encoder.encode(
      JSON.stringify([
        {
          type: EventType.IncrementalSnapshot,
          timestamp: 1,
          data: {
            source: IncrementalSource.MouseMove,
            positions: [{ x: 1, y: 2, id: 1, timeOffset: 2_000 }],
          },
        },
      ]),
    );

    await expect(decodeWithGeneratedWorker(payload)).resolves.toMatchObject({
      type: "decoded",
      id: 1,
      error: expect.stringContaining("invalid incremental replay data"),
      errorName: "ReplayDataError",
    });
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
      "Replay batch contains invalid incremental replay data.",
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
      "Replay batch contains invalid incremental replay data.",
    );
  });

  it("keeps the generated inline worker source on the same validation path", () => {
    const source = makeDecodeWorkerSource();

    expect(source).toContain("validateFullSnapshotData");
    expect(source).toContain("validateIncrementalData");
    expect(source).toContain("limits.maxArrayItems");
    expect(source).toContain("MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS");
    expect(source).toContain("ReplayDataError");
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

function validIncrementalFixtures(): Array<[string, Record<string, unknown>]> {
  return [
    [
      "mutation",
      {
        source: IncrementalSource.Mutation,
        texts: [{ id: 1, value: null }],
        attributes: [],
        removes: [],
        adds: [],
      },
    ],
    [
      "mouse movement",
      {
        source: IncrementalSource.MouseMove,
        positions: [
          { x: 10, y: 20, id: 1, timeOffset: -500 },
          { x: 12, y: 22, id: 1, timeOffset: 0 },
        ],
      },
    ],
    [
      "mouse interaction",
      { source: IncrementalSource.MouseInteraction, type: 2, id: 1, x: 10, y: 20, pointerType: 0 },
    ],
    ["scroll", { source: IncrementalSource.Scroll, id: 1, x: 0, y: 50 }],
    ["viewport resize", { source: IncrementalSource.ViewportResize, width: 1280, height: 720 }],
    ["input", { source: IncrementalSource.Input, id: 1, text: "masked", isChecked: false }],
    [
      "touch movement",
      {
        source: IncrementalSource.TouchMove,
        positions: [{ x: 10, y: 20, id: 1, timeOffset: 0 }],
      },
    ],
    [
      "media interaction",
      { source: IncrementalSource.MediaInteraction, type: 0, id: 1, currentTime: 2 },
    ],
    [
      "stylesheet rule",
      { source: IncrementalSource.StyleSheetRule, id: 1, adds: [{ rule: ".safe {}", index: 0 }] },
    ],
    [
      "canvas mutation",
      {
        source: IncrementalSource.CanvasMutation,
        id: 1,
        type: 0,
        commands: [{ property: "clearRect", args: [0, 0, 10, 10] }],
      },
    ],
    [
      "font",
      {
        source: IncrementalSource.Font,
        family: "Inter",
        fontSource: "url(inter.woff2)",
        buffer: false,
      },
    ],
    [
      "drag movement",
      {
        source: IncrementalSource.Drag,
        positions: [{ x: 10, y: 20, id: 1, timeOffset: 0 }],
      },
    ],
    [
      "style declaration",
      {
        source: IncrementalSource.StyleDeclaration,
        id: 1,
        index: [0],
        set: { property: "color", value: "red", priority: "" },
      },
    ],
    [
      "selection",
      {
        source: IncrementalSource.Selection,
        ranges: [{ start: 1, startOffset: 0, end: 1, endOffset: 2 }],
      },
    ],
    [
      "adopted stylesheet",
      {
        source: IncrementalSource.AdoptedStyleSheet,
        id: 1,
        styleIds: [1],
        styles: [{ styleId: 1, rules: [{ rule: ".safe {}", index: 0 }] }],
      },
    ],
    ["custom element", { source: IncrementalSource.CustomElement }],
  ];
}

async function decodeWithGeneratedWorker(payload: Uint8Array): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const scope = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      postMessage: resolve,
      close: vi.fn(),
    };
    try {
      runInNewContext(makeDecodeWorkerSource(), {
        DecompressionStream,
        Response,
        TextDecoder,
        Uint8Array,
        self: scope,
      });
      const buffer = payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength,
      ) as ArrayBuffer;
      scope.onmessage?.({ data: { type: "decode", id: 1, payload: buffer } } as MessageEvent);
    } catch (error) {
      reject(error);
    }
  });
}
