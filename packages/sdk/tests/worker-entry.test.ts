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

    scope.onmessage?.({
      data: { type: "add", events: [goodEvent, badEvent] },
    } as MessageEvent<unknown>);
    scope.onmessage?.({ data: { type: "flush", id: 3 } } as MessageEvent<unknown>);
    await flushPromises();

    const message = scope.postMessage.mock.calls[0]?.[0] as {
      payload: ArrayBuffer;
      droppedEventCount: number;
      uncompressed: boolean;
    };
    expect(message.uncompressed).toBe(true);
    expect(message.droppedEventCount).toBe(1);
    expect(JSON.parse(decoder.decode(message.payload))).toEqual([goodEvent]);
  });
});

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
  await Promise.resolve();
}
