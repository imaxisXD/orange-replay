import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkerHost } from "../src/pipeline/worker-host.ts";
import {
  estimateEventBytes,
  EventType,
  IncrementalSource,
  type eventWithTime,
} from "@orange-replay/rrweb-fork";

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
  it("fails safely instead of serializing on the main thread when the worker fails", async () => {
    const warn = vi.fn();
    const revokeObjectUrl = vi.fn();
    const onUnavailable = vi.fn();
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl,
      warn,
      onUnavailable,
    });
    const event = makeEvent(1, "before-error");

    addWorkerEvents(host, [event]);
    const flush = host.flushBatch({ eventCount: 1 });
    const expectedFailure = expect(flush).rejects.toThrow("Orange Replay worker is unavailable.");
    FakeWorker.instances[0]?.fail(new Error("CSP blocked worker"));
    await expectedFailure;

    expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:orange-replay-worker");
    await expect(host.flushBatch({ eventCount: 1 })).rejects.toThrow(
      "Orange Replay worker is unavailable.",
    );
  });

  it("times out a silent worker flush and reports unavailability once", async () => {
    vi.useFakeTimers();
    const onUnavailable = vi.fn();
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
      flushTimeoutMs: 5,
      onUnavailable,
    });

    addWorkerEvents(host, [makeEvent(1, "silent")]);
    const flush = host.flushBatch({ eventCount: 1 });
    const expectedRejection = expect(flush).rejects.toThrow("Orange Replay worker timed out.");
    await vi.advanceTimersByTimeAsync(5);

    await expectedRejection;
    expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it("does not transfer ArrayBuffers away from the main-thread copy", async () => {
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
    });
    const buffer = new ArrayBuffer(8);

    addWorkerEvents(host, [
      {
        type: 0,
        timestamp: 1,
        data: { buffer },
      } as unknown as eventWithTime,
    ]);
    await flushWorkerQueue();

    expect(FakeWorker.instances[0]?.postMessage).toHaveBeenCalledWith([
      "a",
      [{ type: 0, timestamp: 1, data: { buffer } }],
    ]);
    expect(buffer.byteLength).toBe(8);
  });

  it("splits regular worker messages near the byte target", async () => {
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
    });
    host.addEvents(
      Array.from(
        { length: 5 },
        (_, index) => [makeEvent(index, `event-${index}`), 100 * 1024] as const,
      ),
    );

    await flushWorkerQueue();

    const addMessages = FakeWorker.instances[0]?.postMessage.mock.calls
      .map((call) => call[0] as [string, eventWithTime[]])
      .filter((message) => message[0] === "a");
    expect(addMessages?.map((message) => message[1].length)).toEqual([2, 2, 1]);
  });

  it("fails closed before posting one oversized regular message", async () => {
    const onUnavailable = vi.fn();
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
      onUnavailable,
    });
    host.addEvents([[makeEvent(1, "oversized"), 4 * 1024 * 1024 + 1]]);

    await flushWorkerQueue();

    expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(
      FakeWorker.instances[0]?.postMessage.mock.calls.some(
        (call) => (call[0] as [string])[0] === "a",
      ),
    ).toBe(false);
  });

  it.each([
    [
      "input",
      IncrementalSource.Input,
      (value: string) => ({ id: 1, text: value, isChecked: false }),
    ],
    [
      "stylesheet rule",
      IncrementalSource.StyleSheetRule,
      (value: string) => ({ adds: [{ rule: value }] }),
    ],
    [
      "style declaration",
      IncrementalSource.StyleDeclaration,
      (value: string) => ({ index: [], set: { property: "--value", value, priority: "" } }),
    ],
    [
      "adopted stylesheet",
      IncrementalSource.AdoptedStyleSheet,
      (value: string) => ({
        id: 1,
        styleIds: [1],
        styles: [{ styleId: 1, rules: [{ rule: value }] }],
      }),
    ],
  ] as const)("rejects one oversized %s before posting it", async (_name, source, makeData) => {
    const event = {
      type: EventType.IncrementalSnapshot,
      timestamp: 1,
      data: { source, ...makeData("x".repeat(2_100_000)) },
    } as eventWithTime;
    const onUnavailable = vi.fn();
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
      onUnavailable,
    });

    host.addEvents([[event, estimateEventBytes(event)]]);
    await flushWorkerQueue();

    const worker = FakeWorker.instances.at(-1)!;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(worker.postMessage.mock.calls.some((call) => (call[0] as [string])[0] === "a")).toBe(
      false,
    );
  });

  it("sends full and iframe snapshots in bounded node chunks", async () => {
    let clock = 0;
    const yieldToMain = vi.fn(async () => undefined);
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
      now: () => (clock += 5),
      yieldToMain,
    });
    const childNodes = Array.from({ length: 600 }, (_, index) => ({
      type: 2,
      id: index + 2,
      tagName: "div",
      attributes: { "data-index": String(index) },
      childNodes: [],
    }));
    const snapshotRoot = { type: 0, id: 1, childNodes };
    const fullSnapshot = {
      type: 2,
      timestamp: 10,
      data: {
        node: snapshotRoot,
        initialOffset: { top: 0, left: 0 },
      },
    } as eventWithTime;
    const iframeSnapshot = {
      type: EventType.IncrementalSnapshot,
      timestamp: 11,
      data: {
        source: IncrementalSource.Mutation,
        adds: [{ parentId: 9, nextId: null, node: snapshotRoot }],
        removes: [],
        texts: [],
        attributes: [],
        isAttachIframe: true,
      },
    } as eventWithTime;

    addWorkerEvents(host, [fullSnapshot, iframeSnapshot]);
    await flushWorkerQueue();

    const messages =
      FakeWorker.instances[0]?.postMessage.mock.calls.map(
        (call) => call[0] as [string, ...unknown[]],
      ) ?? [];
    const nodeMessages = messages.filter(
      (message): message is ["n", unknown[], number[]] => message[0] === "n",
    );
    expect(messages.filter((message) => message[0] === "s")).toHaveLength(2);
    expect(messages.filter((message) => message[0] === "e")).toHaveLength(2);
    expect(nodeMessages).toHaveLength(6);
    expect(nodeMessages.every((message) => message[1].length <= 256)).toBe(true);
    expect(
      messages.some(
        (message) =>
          message[0] === "a" &&
          (((message[1] as eventWithTime[] | undefined)?.includes(fullSnapshot) ?? false) ||
            ((message[1] as eventWithTime[] | undefined)?.includes(iframeSnapshot) ?? false)),
      ),
    ).toBe(false);
    expect(yieldToMain).toHaveBeenCalled();
  });

  it("isolates snapshot nodes that exceed the soft byte target", async () => {
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
    });
    const childNodes = Array.from({ length: 3 }, (_, index) => ({
      type: 3,
      id: index + 2,
      textContent: `${index}${"x".repeat(140_000)}`,
    }));
    addWorkerEvents(host, [
      {
        type: EventType.FullSnapshot,
        timestamp: 10,
        data: {
          node: { type: 0, id: 1, childNodes },
          initialOffset: { top: 0, left: 0 },
        },
      } as eventWithTime,
    ]);

    await flushWorkerQueue();

    const nodeMessages = FakeWorker.instances[0]?.postMessage.mock.calls
      .map((call) => call[0] as [string, unknown[]])
      .filter((message) => message[0] === "n");
    expect(nodeMessages).toHaveLength(4);
    expect(nodeMessages?.every((message) => message[1].length === 1)).toBe(true);
  });

  it("fails closed before posting one oversized snapshot node", async () => {
    const onUnavailable = vi.fn();
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
      onUnavailable,
    });
    addWorkerEvents(host, [
      {
        type: EventType.FullSnapshot,
        timestamp: 10,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [{ type: 3, id: 2, textContent: "x".repeat(2_100_000) }],
          },
          initialOffset: { top: 0, left: 0 },
        },
      } as eventWithTime,
    ]);

    await flushWorkerQueue();

    expect(FakeWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(
      FakeWorker.instances[0]?.postMessage.mock.calls.some(
        (call) => (call[0] as [string])[0] === "n",
      ),
    ).toBe(false);
  });

  it("stops an unfinished snapshot transfer after reset", async () => {
    let releaseYield: (() => void) | undefined;
    let clock = 0;
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
      now: () => (clock += 5),
      yieldToMain: () =>
        new Promise<void>((resolve) => {
          releaseYield = resolve;
        }),
    });
    const childNodes = Array.from({ length: 600 }, (_, index) => ({
      type: 2,
      id: index + 2,
      tagName: "div",
      attributes: {},
      childNodes: [],
    }));
    addWorkerEvents(host, [
      {
        type: 2,
        timestamp: 10,
        data: {
          node: { type: 0, id: 1, childNodes },
          initialOffset: { top: 0, left: 0 },
        },
      } as eventWithTime,
    ]);
    const flush = host.flushBatch({ eventCount: 1 });
    const rejectedFlush = expect(flush).rejects.toThrow("Orange Replay worker reset before flush.");
    await flushWorkerQueue();

    host.reset();
    releaseYield?.();
    await flushWorkerQueue();
    await rejectedFlush;

    const messages =
      FakeWorker.instances[0]?.postMessage.mock.calls.map(
        (call) => call[0] as [string, ...unknown[]],
      ) ?? [];
    const resetIndex = messages.findIndex((message) => message[0] === "r");
    expect(resetIndex).toBeGreaterThan(-1);
    expect(
      messages.slice(resetIndex + 1).some((message) => ["s", "n", "e"].includes(message[0])),
    ).toBe(false);
  });

  it("keeps old flush replies from consuming events added after reset", async () => {
    const host = new WorkerHost({
      WorkerCtor: FakeWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
    });
    const worker = FakeWorker.instances[0]!;
    addWorkerEvents(host, [makeEvent(1, "old")]);
    const oldFlush = host.flushBatch({ eventCount: 1 });
    const rejectedOldFlush = expect(oldFlush).rejects.toThrow(
      "Orange Replay worker reset before flush.",
    );
    await flushWorkerQueue();
    const oldFlushMessage = worker.postMessage.mock.calls
      .map((call) => call[0] as [string, number])
      .find((message) => message[0] === "f")!;

    host.reset();
    await rejectedOldFlush;
    addWorkerEvents(host, [makeEvent(2, "new")]);
    const newFlush = host.flushBatch({ eventCount: 1 });
    await flushWorkerQueue();
    const flushMessages = worker.postMessage.mock.calls
      .map((call) => call[0] as [string, number])
      .filter((message) => message[0] === "f");
    const newFlushMessage = flushMessages.at(-1)!;

    worker.onmessage?.({
      data: ["b", oldFlushMessage[1], new TextEncoder().encode("old").buffer, true],
    } as MessageEvent);
    worker.onmessage?.({
      data: ["b", newFlushMessage[1], new TextEncoder().encode("new").buffer, true],
    } as MessageEvent);

    expect(decoder.decode((await newFlush).payload)).toBe("new");
  });
});

function makeEvent(timestamp: number, name: string): eventWithTime {
  return { type: 0, timestamp, data: { name } } as eventWithTime;
}

function addWorkerEvents(host: WorkerHost, events: eventWithTime[], bytes = 512): void {
  host.addEvents(events.map((event) => [event, bytes] as const));
}

async function flushWorkerQueue(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Promise.resolve();
  }
}
