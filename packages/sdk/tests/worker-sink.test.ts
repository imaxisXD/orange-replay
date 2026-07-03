// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FLAG_UNCOMPRESSED, HDR_FLAGS, HDR_SEQ } from "@orange-replay/shared/constants";
import { decodeIngestBody } from "@orange-replay/shared/wire";
import { PAGEHIDE_RAW_FLUSH_BYTES } from "../src/pipeline/batcher.ts";
import type { WorkerHost } from "../src/pipeline/worker-host.ts";
import { WorkerSink } from "../src/sink.ts";
import { SessionManager, type StorageLike } from "../src/session.ts";
import type { RecorderConfig } from "../src/types.ts";
import type { eventWithTime } from "@orange-replay/rrweb-fork";

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

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workerHost.flushBatch).not.toHaveBeenCalled();

    const beaconBody = sendBeacon.mock.calls[0]?.[1];
    expect(beaconBody).toBeInstanceOf(Uint8Array);
    const decoded = decodeIngestBody(beaconBody as Uint8Array);
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

    sink.addRrwebEvent(makeEvent(1, "old", "x".repeat(40_000)));
    sink.addRrwebEvent(makeEvent(2, "middle", "m".repeat(1_000)));
    sink.addRrwebEvent(makeEvent(3, "newest", "n".repeat(1_000)));
    sink.addIndexEvent({ t: 4, k: "error", d: "latest sidecar event" });

    await sink.flush("pagehide");

    const body = sendBeacon.mock.calls[0]?.[1] as Uint8Array;
    expect(body.byteLength).toBeLessThanOrEqual(PAGEHIDE_RAW_FLUSH_BYTES);
    const decoded = decodeIngestBody(body);
    const events = JSON.parse(decoder.decode(decoded.payload)) as Array<{
      data?: { name?: string };
    }>;
    expect(events.map((event) => event.data?.name)).toEqual(["middle", "newest"]);
    expect(decoded.index.e).toEqual([{ t: 4, k: "error", d: "latest sidecar event" }]);
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

function installSendBeacon(send: (url: string, body?: BodyInit | null) => boolean) {
  const sendBeacon = vi.fn(send);
  Object.defineProperty(window.navigator, "sendBeacon", {
    configurable: true,
    value: sendBeacon,
  });
  return sendBeacon;
}
