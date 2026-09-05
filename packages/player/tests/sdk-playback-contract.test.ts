import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runInNewContext } from "node:vm";
import { randomBytes } from "node:crypto";
import { REPLAY_DATA_LIMITS, MAX_COMPRESSED_BATCH_BYTES } from "@orange-replay/shared/constants";
import { makeWorkerEntrySource } from "../../sdk/src/pipeline/worker-entry.ts";
import { makeDecodeWorkerSource, type DecodeWorkerResponse } from "../src/worker-entry.ts";
import { decodeBatchWithStats } from "../src/worker-core.ts";

afterEach(() => vi.unstubAllGlobals());

describe("recorder and player resource contract", () => {
  it.each([false, true])(
    "plays a repeated DOM snapshot produced by the generated recorder worker (streamed: %s)",
    async (streamed) => {
      const children = Array.from({ length: 4_000 }, (_, index) => ({
        type: 2,
        id: index * 2 + 3,
        tagName: "div",
        attributes: { class: "row flex items-center rounded-lg px-4 py-2 text-sm" },
        childNodes: [
          {
            type: 3,
            id: index * 2 + 4,
            textContent: "A repeated row of ordinary page content. ".repeat(8),
          },
        ],
      }));
      const events = [
        {
          type: 2,
          timestamp: 1_000,
          data: {
            node: {
              type: 0,
              id: 1,
              childNodes: [
                { type: 2, id: 2, tagName: "body", attributes: {}, childNodes: children },
              ],
            },
            initialOffset: { top: 0, left: 0 },
          },
        },
      ];
      const payload = await recordWithGeneratedWorker(events, { streamed });
      const decoded = await decodeWithGeneratedWorker(payload);

      expect(new TextEncoder().encode(JSON.stringify(events)).byteLength).toBeGreaterThan(
        1024 * 1024,
      );
      expect(payload.byteLength).toBeLessThan(64 * 1024);
      expect("error" in decoded ? decoded.error : undefined).toBeUndefined();
      expect(decoded).toMatchObject({ type: "decoded", events });
    },
  );

  it.each([REPLAY_DATA_LIMITS.bytes, REPLAY_DATA_LIMITS.bytes + 1])(
    "enforces an exact %s-byte JSON boundary",
    async (bytes) => {
      const empty = [{ type: 0, timestamp: 1_000, data: { text: "" } }];
      const textBytes = bytes - new Blob([JSON.stringify(empty)]).size;
      empty[0]!.data.text = "x".repeat(textBytes);
      if (bytes > REPLAY_DATA_LIMITS.bytes) {
        await expect(recordWithGeneratedWorker(empty)).rejects.toThrow("too large after decoding");
      } else {
        const decoded = await decodeWithGeneratedWorker(await recordWithGeneratedWorker(empty));
        expect("error" in decoded ? decoded.error : undefined).toBeUndefined();
        expect("decodedBytes" in decoded ? decoded.decodedBytes : undefined).toBe(bytes);
      }
    },
  );

  it("counts UTF-8 and JSON escaping when limiting a serialized batch", async () => {
    const events = [{ type: 0, timestamp: 1_000, data: { text: "漢\u0000".repeat(2_000_000) } }];
    expect(JSON.stringify(events).length).toBeLessThan(REPLAY_DATA_LIMITS.bytes);
    expect(new Blob([JSON.stringify(events)]).size).toBeGreaterThan(REPLAY_DATA_LIMITS.bytes);
    await expect(recordWithGeneratedWorker(events)).rejects.toThrow("too large after decoding");
  });

  it("refuses a compressed payload that ingest would reject", async () => {
    const text = randomBytes(MAX_COMPRESSED_BATCH_BYTES * 2).toString("base64");
    await expect(
      recordWithGeneratedWorker([{ type: 0, timestamp: 1_000, data: { text } }]),
    ).rejects.toThrow("too large to send");
  });

  it("refuses an oversized uncompressed fallback", async () => {
    const events = [
      { type: 0, timestamp: 1_000, data: { text: "x".repeat(MAX_COMPRESSED_BATCH_BYTES) } },
    ];
    await expect(recordWithGeneratedWorker(events, { compression: false })).rejects.toThrow(
      "too large to send",
    );
  });

  it.each([
    [
      "event count",
      () =>
        Array.from({ length: REPLAY_DATA_LIMITS.events + 1 }, () => ({
          type: 0,
          timestamp: 1_000,
          data: {},
        })),
    ],
    [
      "array size",
      () => [
        {
          type: 0,
          timestamp: 1_000,
          data: { items: Array.from({ length: REPLAY_DATA_LIMITS.arrayItems + 1 }, () => 0) },
        },
      ],
    ],
    [
      "object fields",
      () => [
        {
          type: 0,
          timestamp: 1_000,
          data: Object.fromEntries(
            Array.from({ length: REPLAY_DATA_LIMITS.fields + 1 }, (_, index) => [
              `field${index}`,
              0,
            ]),
          ),
        },
      ],
    ],
    [
      "combined values",
      () =>
        Array.from({ length: 25 }, () => ({
          type: 0,
          timestamp: 1_000,
          data: { items: Array.from({ length: REPLAY_DATA_LIMITS.arrayItems }, () => 0) },
        })),
    ],
  ] as const)("refuses regular events beyond the player's %s limit", async (_name, makeEvents) => {
    await expect(recordWithGeneratedWorker(makeEvents())).rejects.toThrow(/too many|too complex/);
  });

  it("refuses a streamed snapshot whose descendants exceed the array limit", async () => {
    const node = {
      type: 0,
      id: 1,
      childNodes: Array.from({ length: REPLAY_DATA_LIMITS.arrayItems + 1 }, (_, index) => ({
        type: 3,
        id: index + 2,
        textContent: "text",
      })),
    };
    await expect(
      recordWithGeneratedWorker([snapshotEvent(node)], { streamed: true }),
    ).rejects.toThrow("too complex");
  });

  it("refuses a streamed snapshot that exceeds the player's JSON depth", async () => {
    let node: Record<string, unknown> = { type: 3, id: 1, textContent: "text" };
    for (let depth = 0; depth < REPLAY_DATA_LIMITS.depth; depth += 1) {
      node = { type: 2, id: depth + 2, tagName: "div", attributes: {}, childNodes: [node] };
    }
    await expect(
      recordWithGeneratedWorker([snapshotEvent(node)], { streamed: true }),
    ).rejects.toThrow("too deeply nested");
  });

  it.each([false, true])(
    "cancels and releases an oversized decoded stream (generated: %s)",
    async (generated) => {
      const cancel = vi.fn(() => {
        throw new Error("Cancellation failed.");
      });
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(REPLAY_DATA_LIMITS.bytes + 1));
        },
        cancel,
      });
      vi.stubGlobal(
        "DecompressionStream",
        class {
          readonly readable = readable;
          readonly writable = new WritableStream();
        },
      );
      const payload = new Uint8Array([1]);
      if (generated) {
        expect(await decodeWithGeneratedWorker(payload)).toMatchObject({
          error: "Replay batch is too large after decoding.",
          errorName: "ReplayDecodeLimitError",
        });
      } else {
        await expect(decodeBatchWithStats(payload)).rejects.toMatchObject({
          message: "Replay batch is too large after decoding.",
          name: "ReplayDecodeLimitError",
        });
      }
      expect(cancel).toHaveBeenCalledOnce();
      expect(readable.locked).toBe(false);
    },
  );
});

function snapshotEvent(node: Record<string, unknown>) {
  return { type: 2, timestamp: 1_000, data: { node, initialOffset: { top: 0, left: 0 } } };
}

async function recordWithGeneratedWorker(
  events: unknown[],
  options: { streamed?: boolean; compression?: boolean } = {},
): Promise<Uint8Array> {
  const message = await new Promise<unknown[]>((resolve) => {
    const scope = {
      onmessage: null as ((event: { data: unknown[] }) => void) | null,
      postMessage: resolve,
    };
    runInNewContext(makeWorkerEntrySource(), {
      self: scope,
      Blob,
      Response,
      CompressionStream: options.compression === false ? undefined : CompressionStream,
      Uint8Array,
    });
    if (options.streamed) {
      for (const event of events as Array<{
        type: number;
        timestamp: number;
        data: { node: Record<string, unknown> };
      }>) {
        scope.onmessage?.({ data: ["s", { ...event, data: { ...event.data, node: null } }] });
        const pending = [{ node: event.data.node, depth: 0 }];
        while (pending.length > 0) {
          const { node, depth } = pending.pop()!;
          const children = node["childNodes"] as Record<string, unknown>[] | undefined;
          scope.onmessage?.({
            data: ["n", [children === undefined ? node : { ...node, childNodes: [] }], [depth]],
          });
          for (let index = (children?.length ?? 0) - 1; index >= 0; index -= 1) {
            pending.push({ node: children![index]!, depth: depth + 1 });
          }
        }
        scope.onmessage?.({ data: ["e"] });
      }
    } else scope.onmessage?.({ data: ["a", events] });
    scope.onmessage?.({ data: ["f", 1] });
  });
  if (message[2] === null) throw new Error(String(message[5]));
  expect(message[2]).toBeInstanceOf(ArrayBuffer);
  return new Uint8Array(message[2] as ArrayBuffer);
}

async function decodeWithGeneratedWorker(payload: Uint8Array): Promise<DecodeWorkerResponse> {
  return await new Promise((resolve) => {
    const scope = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: resolve,
    };
    runInNewContext(makeDecodeWorkerSource(), {
      self: scope,
      Response,
      DecompressionStream,
      Uint8Array,
      TextDecoder,
    });
    scope.onmessage?.({ data: { type: "decode", id: 1, payload: payload.buffer } });
  });
}
