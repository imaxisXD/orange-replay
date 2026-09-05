import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createContext, Script } from "node:vm";
import { CompressionStream } from "node:stream/web";
import { gunzipSync } from "node:zlib";
import { makeWorkerEntrySource } from "../src/pipeline/worker-entry.ts";
import type { eventWithTime } from "@orange-replay/rrweb-fork";

interface TestWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const decoder = new TextDecoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker entry", () => {
  it("runs the production worker string and drops only bad events", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const scope = makeScope();
    const script = new Script(makeWorkerEntrySource());
    script.runInContext(
      createContext({
        self: scope,
        TextEncoder,
        Response,
        Blob,
        Uint8Array,
        ArrayBuffer,
        JSON,
        Error,
        Number,
        Math,
        Promise,
      }),
    );

    const goodEvent = makeEvent(1, "good");
    const badEvent = {
      type: 0,
      timestamp: 2,
      data: { amount: 10n },
    } as unknown as eventWithTime;

    scope.onmessage?.({ data: ["a", [goodEvent, badEvent]] } as MessageEvent<unknown>);
    scope.onmessage?.({ data: ["f", 3] } as MessageEvent<unknown>);
    await flushPromises();

    const message = scope.postMessage.mock.calls[0]?.[0] as [
      string,
      number,
      ArrayBuffer,
      boolean,
      number,
    ];
    expect(message[3]).toBe(true);
    expect(message[4]).toBe(1);
    expect(JSON.parse(decoder.decode(message[2]))).toEqual([goodEvent]);
  });

  it("rebuilds a chunked full snapshot before flushing", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const scope = makeScope();
    const script = new Script(makeWorkerEntrySource());
    script.runInContext(
      createContext({
        self: scope,
        TextEncoder,
        Response,
        Blob,
        Uint8Array,
        ArrayBuffer,
        JSON,
        Error,
        Number,
        Math,
        Promise,
        Map,
        Array,
      }),
    );

    scope.onmessage?.({
      data: [
        "s",
        {
          type: 2,
          timestamp: 10,
          data: { node: null, initialOffset: { top: 3, left: 4 } },
        },
      ],
    } as MessageEvent<unknown>);
    scope.onmessage?.({
      data: [
        "n",
        [
          { type: 0, id: 1, childNodes: [] },
          { type: 2, id: 2, tagName: "main", attributes: {}, childNodes: [] },
        ],
        [0, 1],
      ],
    } as MessageEvent<unknown>);
    scope.onmessage?.({ data: ["e"] } as MessageEvent<unknown>);
    scope.onmessage?.({ data: ["f", 8] } as MessageEvent<unknown>);
    await flushPromises();

    const message = scope.postMessage.mock.calls[0]?.[0] as [string, number, ArrayBuffer];
    expect(JSON.parse(decoder.decode(message[2]))).toEqual([
      {
        type: 2,
        timestamp: 10,
        data: {
          initialOffset: { top: 3, left: 4 },
          node: {
            type: 0,
            id: 1,
            childNodes: [{ type: 2, id: 2, tagName: "main", attributes: {}, childNodes: [] }],
          },
        },
      },
    ]);
  });

  it("rebuilds a chunked iframe attachment before flushing", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const scope = makeScope();
    runWorkerEntry(scope);
    const event = {
      type: 3,
      timestamp: 12,
      data: {
        source: 0,
        adds: [{ parentId: 9, nextId: null, node: null }],
        removes: [],
        texts: [],
        attributes: [],
        isAttachIframe: true,
      },
    };

    scope.onmessage?.({ data: ["s", event] } as MessageEvent<unknown>);
    scope.onmessage?.({
      data: ["n", [{ type: 0, id: 20, childNodes: [] }], [0]],
    } as MessageEvent<unknown>);
    scope.onmessage?.({ data: ["e"] } as MessageEvent<unknown>);
    scope.onmessage?.({ data: ["f", 9] } as MessageEvent<unknown>);
    await flushPromises();

    const message = scope.postMessage.mock.calls[0]?.[0] as [string, number, ArrayBuffer];
    expect(JSON.parse(decoder.decode(message[2]))).toEqual([
      {
        ...event,
        data: {
          ...event.data,
          adds: [{ parentId: 9, nextId: null, node: { type: 0, id: 20, childNodes: [] } }],
        },
      },
    ]);
  });

  it.each([false, true])(
    "releases snapshot scratch memory and preserves queued snapshots (gzip: %s)",
    async (gzip) => {
      const scope = makeScope();
      const context = runWorkerEntry(scope, gzip ? CompressionStream : undefined, true);
      const expectedEvents = [];

      for (const timestamp of [20, 30]) {
        const children = Array.from({ length: 1_024 }, (_, index) => ({
          type: 2,
          id: index + 2,
          tagName: "article",
          attributes: { title: `${timestamp}-${index}-${"x".repeat(gzip ? 1_000 : 300)}` },
          childNodes: [],
        }));
        const root = { type: 0, id: 1, childNodes: [] };
        const event = {
          type: 2,
          timestamp,
          data: { node: null, initialOffset: { top: 0, left: 0 } },
        };
        scope.onmessage?.({ data: ["s", event] } as MessageEvent<unknown>);
        scope.onmessage?.({ data: ["n", [root], [0]] } as MessageEvent<unknown>);
        for (let start = 0; start < children.length; start += 128) {
          const nodes = children.slice(start, start + 128);
          scope.onmessage?.({
            data: ["n", nodes, nodes.map(() => 1)],
          } as MessageEvent<unknown>);
        }
        scope.onmessage?.({ data: ["e"] } as MessageEvent<unknown>);
        expectedEvents.push({
          ...event,
          data: { ...event.data, node: { ...root, childNodes: children } },
        });

        // The completed snapshot belongs to the queue now. The worker must
        // not retain a second root to its raw JSON after that queue drains.
        expect(new Script("self.readScratch().chunks").runInContext(context)).toBe(0);
      }

      scope.onmessage?.({ data: ["f", 11] } as MessageEvent<unknown>);
      await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledOnce());
      const message = scope.postMessage.mock.calls[0]?.[0] as [
        string,
        number,
        ArrayBuffer,
        boolean,
        number,
      ];
      const payload = gzip ? gunzipSync(new Uint8Array(message[2])) : message[2];
      expect(JSON.parse(decoder.decode(payload))).toEqual(expectedEvents);
      expect(message[3]).toBe(!gzip);
      expect(message[4]).toBe(0);
      expect(new Script("self.readScratch()").runInContext(context)).toEqual({
        events: 0,
        chunks: 0,
      });
    },
  );

  it("serializes a playable nested snapshot through chunks", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const scope = makeScope();
    runWorkerEntry(scope);
    // The player's JSON limit includes the event wrapper and child arrays.
    const nodeCount = 62;

    scope.onmessage?.({
      data: [
        "s",
        {
          type: 2,
          timestamp: 14,
          data: { node: null, initialOffset: { top: 0, left: 0 } },
        },
      ],
    } as MessageEvent<unknown>);
    for (let start = 0; start < nodeCount; start += 256) {
      const end = Math.min(start + 256, nodeCount);
      const nodes = [];
      const depths = [];
      for (let index = start; index < end; index += 1) {
        nodes.push({ type: 2, id: index + 1, tagName: "div", attributes: {}, childNodes: [] });
        depths.push(index);
      }
      scope.onmessage?.({
        data: ["n", nodes, depths],
      } as MessageEvent<unknown>);
    }
    scope.onmessage?.({ data: ["e"] } as MessageEvent<unknown>);
    scope.onmessage?.({ data: ["f", 10] } as MessageEvent<unknown>);
    await flushPromises();

    const message = scope.postMessage.mock.calls[0]?.[0] as [
      string,
      number,
      ArrayBuffer,
      boolean,
      number,
    ];
    const [recorded] = JSON.parse(decoder.decode(message[2])) as Array<{
      data: { node: { id: number; childNodes: Array<unknown> } };
    }>;
    let node = recorded!.data.node;
    let visited = 1;
    while (node.childNodes.length > 0) {
      node = node.childNodes[0] as typeof node;
      visited += 1;
    }
    expect(visited).toBe(nodeCount);
    expect(node.id).toBe(nodeCount);
    expect(message[4]).toBe(0);
  });
});

function runWorkerEntry(
  scope: TestWorkerScope,
  compressionStream?: typeof CompressionStream,
  inspectScratch = false,
) {
  let source = makeWorkerEntrySource();
  if (inspectScratch) {
    // The worker now owns its state inside a self-contained factory. Add a
    // test-only observer within that scope; nothing is exposed in the bundle.
    expect(source).toContain("let snapshotValues = 0;");
    source = source.replace(
      "let snapshotValues = 0;",
      "let snapshotValues = 0; self.readScratch = () => ({events: events.length, chunks: treeChunks.length});",
    );
  }
  const script = new Script(source);
  const context = createContext({
    self: scope,
    TextEncoder,
    Response,
    Blob,
    Uint8Array,
    ArrayBuffer,
    JSON,
    Error,
    Number,
    Math,
    Promise,
    Map,
    Array,
    CompressionStream: compressionStream,
  });
  script.runInContext(context);
  return context;
}

function makeScope(): TestWorkerScope {
  return {
    onmessage: null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
}

function makeEvent(timestamp: number, name: string): eventWithTime {
  return { type: 0, timestamp, data: { name } } as eventWithTime;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
