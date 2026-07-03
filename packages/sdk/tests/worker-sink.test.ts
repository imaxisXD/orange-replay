// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FLAG_UNCOMPRESSED, HDR_FLAGS } from "@orange-replay/shared/constants";
import { decodeIngestBody } from "@orange-replay/shared/wire";
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
