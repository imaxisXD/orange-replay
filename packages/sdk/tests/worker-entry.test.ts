import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createContext, Script } from "node:vm";
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

  it("serializes a deeply nested snapshot without recursive JSON stringify", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const scope = makeScope();
    runWorkerEntry(scope);
    const nodeCount = 12_000;

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

function runWorkerEntry(scope: TestWorkerScope): void {
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
