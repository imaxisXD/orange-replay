// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FLAG_UNCOMPRESSED, HDR_FLAGS, HDR_SEQ } from "@orange-replay/shared/constants";
import { decodeIngestBody } from "@orange-replay/shared/wire";
import { PAGEHIDE_RAW_FLUSH_BYTES } from "../src/pipeline/batcher.ts";
import type { WorkerBatchResult } from "../src/pipeline/worker-core.ts";
import type { WorkerHost } from "../src/pipeline/worker-host.ts";
import { WorkerSink } from "../src/sink.ts";
import { SessionManager, type StorageLike } from "../src/session.ts";
import type { RecorderConfig } from "../src/types.ts";
import { EventType, type eventWithTime } from "@orange-replay/rrweb-fork";

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const config: RecorderConfig = {
  key: "write-key",
  ingestUrl: "https://ingest.test",
  projectRef: "write-key",
  transport: "worker",
  sampleRate: 1,
  allowUrlParams: [],
  flushMs: 15_000,
};

const decoder = new TextDecoder();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "or_s=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
  window.sessionStorage.clear();
});

describe("WorkerSink degraded path", () => {
  it("flushes a compressed wire-valid ingest body when Worker is unavailable", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 7_000 }));
    });
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock });

    sink.addRrwebEvent({ type: 0, timestamp: 10, data: { href: "/home" } } as eventWithTime);
    sink.addIndexEvent({ t: 12, k: "click", d: "button#buy", m: { x: 0.5, y: 0.25 } });
    await sink.flush("manual");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.headers).toMatchObject({ [HDR_FLAGS]: "0" });
    const decoded = decodeIngestBody(calls[0]?.init?.body as Uint8Array);
    const events = JSON.parse(await gunzipToText(decoded.payload)) as eventWithTime[];
    expect(events).toHaveLength(1);
    expect(decoded.index).toMatchObject({
      s: "session-one",
      tab: "tab-one",
      seq: 0,
      t0: 10,
      t1: 12,
    });
    expect(sink.getFlushMs()).toBe(7_000);
  });

  it("sets the uncompressed flag when gzip is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock });

    sink.addRrwebEvent({ type: 0, timestamp: 10, data: { href: "/home" } } as eventWithTime);
    await sink.flush("manual");

    expect(calls[0]?.init?.headers).toMatchObject({
      [HDR_FLAGS]: String(FLAG_UNCOMPRESSED),
    });
    const decoded = decodeIngestBody(calls[0]?.init?.body as Uint8Array);
    expect(JSON.parse(decoder.decode(decoded.payload))).toHaveLength(1);
  });

  it("posts rrweb events to the worker in one microtask batch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeResolvedWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(1, "one"));
    sink.addRrwebEvent(makeEvent(2, "two"));
    sink.addRrwebEvent(makeEvent(3, "three"));
    await flushMicrotasks();

    expect(workerHost.addEvents).toHaveBeenCalledTimes(1);
    expect(workerHost.addEvents.mock.calls[0]?.[0]).toHaveLength(3);
  });
});

describe("WorkerSink session rotation", () => {
  it("flushes pending old-session events before a new full snapshot batch", async () => {
    const bodies: Uint8Array[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeCollectingWorkerHost();
    const session = makeSession(["session-one", "tab-one", "session-two"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(1, "old-session"));
    await sink.prepareForSessionRotation();
    session.rotate();
    sink.resetAfterSessionRotation();
    sink.addRrwebEvent({
      type: EventType.FullSnapshot,
      timestamp: 2,
      data: { node: { id: 1, type: 0 }, initialOffset: { left: 0, top: 0 } },
    } as eventWithTime);
    await sink.flush("manual");

    expect(bodies).toHaveLength(2);
    const oldBatch = decodeIngestBody(bodies[0] ?? new Uint8Array());
    const newBatch = decodeIngestBody(bodies[1] ?? new Uint8Array());
    expect(oldBatch.index).toMatchObject({ s: "session-one", seq: 0 });
    expect(newBatch.index).toMatchObject({ s: "session-two", seq: 0 });
    expect(JSON.parse(decoder.decode(newBatch.payload))[0]).toMatchObject({
      type: EventType.FullSnapshot,
    });
    expect(workerHost.reset).toHaveBeenCalledTimes(1);
  });
});

describe("WorkerSink pagehide final flush", () => {
  it("queues a wire-valid uncompressed body synchronously", async () => {
    const sendBeacon = installSendBeacon(() => true);
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(10, "initial"));
    sink.addIndexEvent({ t: 12, k: "error", d: "Cannot read properties of undefined (run)" });

    const flushed = sink.flush("pagehide");

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workerHost.flushBatch).not.toHaveBeenCalled();

    const fetchBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(fetchBody).toBeInstanceOf(Uint8Array);
    const decoded = decodeIngestBody(fetchBody as Uint8Array);
    expect(decoded.index).toMatchObject({
      s: "session-one",
      tab: "tab-one",
      seq: 0,
      e: [{ t: 12, k: "error", d: "Cannot read properties of undefined (run)" }],
    });
    expect(JSON.parse(decoder.decode(decoded.payload))).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      [HDR_FLAGS]: String(FLAG_UNCOMPRESSED),
      [HDR_SEQ]: "0",
    });

    await flushed;
  });

  it("keeps the newest fitting events under the pagehide budget and counts drops", async () => {
    const sendBeacon = installSendBeacon(() => true);
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost: makeWorkerHost(),
    });

    sink.addRrwebEvent(makeEvent(1, "old", "x".repeat(80_000)));
    sink.addRrwebEvent(makeEvent(2, "middle", "m".repeat(1_000)));
    sink.addRrwebEvent(makeEvent(3, "newest", "n".repeat(1_000)));
    sink.addIndexEvent({ t: 4, k: "error", d: "latest sidecar event" });

    await sink.flush("pagehide");

    expect(sendBeacon).not.toHaveBeenCalled();
    const body = fetchMock.mock.calls[0]?.[1]?.body as Uint8Array;
    expect(body.byteLength).toBeLessThanOrEqual(PAGEHIDE_RAW_FLUSH_BYTES);
    const decoded = decodeIngestBody(body);
    const events = JSON.parse(decoder.decode(decoded.payload)) as Array<{
      data?: { name?: string };
    }>;
    expect(events.map((event) => event.data?.name)).toEqual(["middle", "newest"]);
    expect(decoded.index.e).toEqual([{ t: 4, k: "error", d: "latest sidecar event" }]);
    expect(sink.droppedEventCount()).toBe(1);
  });

  it("does not re-stringify the whole final batch once per dropped event", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost: makeWorkerHost(),
    });
    const stringifySpy = vi.spyOn(JSON, "stringify");

    for (let index = 0; index < 180; index += 1) {
      sink.addRrwebEvent(makeEvent(index, `event-${index}`, "x".repeat(900)));
    }

    await sink.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stringifySpy.mock.calls.length).toBeLessThanOrEqual(20);
    expect(sink.droppedEventCount()).toBeGreaterThan(0);
  });

  it("keeps total pagehide sync bodies under one keepalive budget", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const workerHost = makeWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(1, "current", "x".repeat(10_000)));
    await sink.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = fetchMock.mock.calls[0]?.[1]?.body as Uint8Array;
    expect(body.byteLength).toBeLessThanOrEqual(PAGEHIDE_RAW_FLUSH_BYTES);
  });

  it("counts a queued keepalive batch as dropped when the fetch later fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network closed"));
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost: makeWorkerHost(),
    });

    sink.addRrwebEvent(makeEvent(10, "final"));
    await sink.flush("pagehide");
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sink.droppedEventCount()).toBe(1);
  });
});

describe("WorkerSink worker failures", () => {
  it("retries a rejected worker flush through the inline fallback path", async () => {
    const event = makeEvent(10, "retry");
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeRetryWorkerHost(event);
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(event);
    await sink.flush("manual");

    expect(workerHost.reset).toHaveBeenCalledTimes(1);
    expect(workerHost.addEvents).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const decoded = decodeIngestBody(fetchMock.mock.calls[0]?.[1]?.body as Uint8Array);
    expect(JSON.parse(decoder.decode(decoded.payload))).toEqual([event]);
  });

  it("catches unrecoverable worker flush errors and disables the sink once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>();
    const workerHost = makeFailingWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(10, "bad"));
    await expect(sink.flush("manual")).resolves.toBeUndefined();
    sink.addRrwebEvent(makeEvent(11, "ignored"));
    await sink.flush("manual");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(workerHost.stop).toHaveBeenCalledTimes(1);
    expect(sink.droppedEventCount()).toBe(1);
  });
});

describe("WorkerSink async visibility flushes", () => {
  it("does not take the destructive sync pagehide path while a flush is in flight", async () => {
    const sendBeacon = installSendBeacon(() => true);
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const pendingWorker = makePendingWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost: pendingWorker.workerHost,
    });

    sink.addRrwebEvent(makeEvent(10, "visible"));
    const firstFlush = sink.flush("manual");
    const secondFlush = sink.flush("visibility");

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingWorker.workerHost.reset).not.toHaveBeenCalled();

    pendingWorker.resolve({
      payload: new TextEncoder().encode(JSON.stringify([makeEvent(10, "visible")])),
      uncompressed: true,
    });
    await firstFlush;
    await secondFlush;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(false);
  });
});

describe("WorkerSink server and transport drops", () => {
  it("notifies when an ingest ack asks for a checkpoint", async () => {
    const onCheckpointRequested = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({ ok: true, live: true, flushMs: 4_000, checkpoint: true }),
      );
    });
    const workerHost = makeResolvedWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost,
      onCheckpointRequested,
    });

    sink.addRrwebEvent(makeEvent(10, "checkpoint"));
    await sink.flush("manual");

    expect(onCheckpointRequested).toHaveBeenCalledTimes(1);
  });

  it("stops sending after the server returns a drop ack", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000, drop: true }), {
        status: 202,
      });
    });
    const workerHost = makeResolvedWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(10, "before-drop"));
    await sink.flush("manual");
    sink.addRrwebEvent(makeEvent(11, "after-drop"));
    await sink.flush("manual");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workerHost.stop).toHaveBeenCalledTimes(1);
  });

  it("counts batches dropped by transport failures", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("bad key", { status: 401 }));
    const workerHost = makeResolvedWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(10, "dropped"));
    await sink.flush("manual");

    expect(sink.droppedEventCount()).toBe(1);
  });
});

async function gunzipToText(payload: Uint8Array): Promise<string> {
  const body = new Response(payload as unknown as BodyInit).body;
  if (body === null) {
    throw new Error("test gzip body missing");
  }

  const plain = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return decoder.decode(plain);
}

function makeSession(ids: string[]): SessionManager {
  return new SessionManager({
    projectRef: "write-key",
    now: () => 1_000,
    storage: new MemoryStorage(),
    document,
    makeId: () => ids.shift() ?? "extra-id",
  });
}

function makeEvent(timestamp: number, name: string, value = ""): eventWithTime {
  return {
    type: 0,
    timestamp,
    data: { name, value },
  } as eventWithTime;
}

function makeWorkerHost(): {
  addEvents: ReturnType<typeof vi.fn>;
  flushBatch: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} & WorkerHost {
  return {
    addEvents: vi.fn(),
    flushBatch: vi.fn(async () => {
      throw new Error("worker flush should not run during pagehide");
    }),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as {
    addEvents: ReturnType<typeof vi.fn>;
    flushBatch: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } & WorkerHost;
}

function makeRetryWorkerHost(event: eventWithTime): {
  addEvents: ReturnType<typeof vi.fn>;
  flushBatch: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} & WorkerHost {
  return {
    addEvents: vi.fn(),
    flushBatch: vi
      .fn()
      .mockRejectedValueOnce(new Error("worker failed"))
      .mockResolvedValueOnce({
        payload: new TextEncoder().encode(JSON.stringify([event])),
        uncompressed: true,
      } satisfies WorkerBatchResult),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as {
    addEvents: ReturnType<typeof vi.fn>;
    flushBatch: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } & WorkerHost;
}

function makeFailingWorkerHost(): {
  addEvents: ReturnType<typeof vi.fn>;
  flushBatch: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} & WorkerHost {
  return {
    addEvents: vi.fn(),
    flushBatch: vi.fn().mockRejectedValue(new Error("worker failed")),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as {
    addEvents: ReturnType<typeof vi.fn>;
    flushBatch: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } & WorkerHost;
}

function makeResolvedWorkerHost(): {
  addEvents: ReturnType<typeof vi.fn>;
  flushBatch: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} & WorkerHost {
  return {
    addEvents: vi.fn(),
    flushBatch: vi.fn(async () => {
      return {
        payload: new TextEncoder().encode(JSON.stringify([])),
        uncompressed: true,
      } satisfies WorkerBatchResult;
    }),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as {
    addEvents: ReturnType<typeof vi.fn>;
    flushBatch: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } & WorkerHost;
}

function makeCollectingWorkerHost(): {
  addEvents: ReturnType<typeof vi.fn>;
  flushBatch: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} & WorkerHost {
  const events: eventWithTime[] = [];
  return {
    addEvents: vi.fn((nextEvents: eventWithTime[]) => {
      events.push(...nextEvents);
    }),
    flushBatch: vi.fn(async ({ eventCount }: { eventCount?: number } = {}) => {
      const take = eventCount ?? events.length;
      const batch = events.splice(0, take);
      return {
        payload: new TextEncoder().encode(JSON.stringify(batch)),
        uncompressed: true,
      } satisfies WorkerBatchResult;
    }),
    reset: vi.fn(() => {
      events.splice(0);
    }),
    stop: vi.fn(),
  } as unknown as {
    addEvents: ReturnType<typeof vi.fn>;
    flushBatch: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } & WorkerHost;
}

function makePendingWorkerHost(): {
  workerHost: {
    addEvents: ReturnType<typeof vi.fn>;
    flushBatch: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } & WorkerHost;
  resolve: (result: WorkerBatchResult) => void;
} {
  let resolveFlush: (result: WorkerBatchResult) => void = () => undefined;
  const flushPromise = new Promise<WorkerBatchResult>((resolve) => {
    resolveFlush = resolve;
  });
  const workerHost = {
    addEvents: vi.fn(),
    flushBatch: vi.fn(() => flushPromise),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as {
    addEvents: ReturnType<typeof vi.fn>;
    flushBatch: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } & WorkerHost;

  return { workerHost, resolve: resolveFlush };
}

function installSendBeacon(send: (url: string, body?: BodyInit | null) => boolean) {
  const sendBeacon = vi.fn(send);
  Object.defineProperty(window.navigator, "sendBeacon", {
    configurable: true,
    value: sendBeacon,
  });
  return sendBeacon;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
