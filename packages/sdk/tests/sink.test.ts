// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FLAG_UNCOMPRESSED, HDR_FLAGS, HDR_SEQ } from "@orange-replay/shared/constants";
import { decodeIngestBody } from "@orange-replay/shared/wire";
import { CheckpointSnapshotLimiter } from "../src/checkpoint.ts";
import { InlineSink } from "../src/sink.ts";
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
  sampleRate: 1,
  maskPolicyVersion: 0,
  capture: { heatmaps: false, console: false, network: false, canvas: false },
  allowUrlParams: ["keep"],
  flushMs: 15_000,
};

afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = "or_s=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
  window.sessionStorage.clear();
});

describe("InlineSink", () => {
  it("encodes a valid uncompressed ingest batch", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 7_000 }));
    });
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new InlineSink({ config, session, window, fetch: fetchMock });

    sink.addRrwebEvent({ type: 0, timestamp: 10, data: { href: "/home" } } as eventWithTime);
    sink.addIndexEvent({ t: 12, k: "click", d: "button#buy", m: { x: 0.5, y: 0.25 } });
    await sink.flush("manual");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://ingest.test/v1/ingest");
    expect(calls[0]?.init?.headers).toMatchObject({
      [HDR_FLAGS]: String(FLAG_UNCOMPRESSED),
      [HDR_SEQ]: "0",
    });
    const body = calls[0]?.init?.body;
    expect(body).toBeInstanceOf(Uint8Array);
    const decoded = decodeIngestBody(body as Uint8Array);

    expect(decoded.index).toMatchObject({
      v: 1,
      s: "session-one",
      tab: "tab-one",
      seq: 0,
      t0: 10,
      t1: 12,
      u: "/",
    });
    expect(decoded.index.e).toEqual([
      { t: 12, k: "click", d: "button#buy", m: { x: 0.5, y: 0.25 } },
    ]);
    expect(JSON.parse(new TextDecoder().decode(decoded.payload))).toHaveLength(1);
    expect(sink.getFlushMs()).toBe(7_000);
  });

  it("increments seq for each flushed batch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new InlineSink({ config, session, window, fetch: fetchMock });

    sink.addRrwebEvent({ type: 0, timestamp: 1, data: {} } as eventWithTime);
    await sink.flush("manual");
    sink.addRrwebEvent({ type: 0, timestamp: 2, data: {} } as eventWithTime);
    await sink.flush("manual");

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ [HDR_SEQ]: "0" });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ [HDR_SEQ]: "1" });
  });

  it("rotates the session on a closed ingest ack", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000, closed: true }));
    });
    const session = makeSession(["session-one", "tab-one", "session-two"]);
    const sink = new InlineSink({ config, session, window, fetch: fetchMock });

    sink.addRrwebEvent({ type: 0, timestamp: 1, data: {} } as eventWithTime);
    await sink.flush("manual");

    expect(session.sessionId).toBe("session-two");
    expect(session.nextSeq()).toBe(0);
  });

  it("uses checkpoint acks to request throttled full snapshots", async () => {
    const takeFullSnapshot = vi.fn();
    let now = 1_000;
    const snapshots = new CheckpointSnapshotLimiter({
      recorder: { takeFullSnapshot },
      now: () => now,
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({ ok: true, live: true, flushMs: 4_000, checkpoint: true }),
      );
    });
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new InlineSink({
      config,
      session,
      window,
      fetch: fetchMock,
      onCheckpointRequested: () => snapshots.requestSnapshot(),
    });

    sink.addRrwebEvent({ type: 0, timestamp: 1, data: {} } as eventWithTime);
    await sink.flush("manual");
    sink.addRrwebEvent({ type: 0, timestamp: 2, data: {} } as eventWithTime);
    await sink.flush("manual");
    now += 5_000;
    sink.addRrwebEvent({ type: 0, timestamp: 3, data: {} } as eventWithTime);
    await sink.flush("manual");

    expect(takeFullSnapshot).toHaveBeenCalledTimes(2);
  });
});

function makeSession(ids: string[]): SessionManager {
  return new SessionManager({
    projectRef: "write-key",
    now: () => 1_000,
    storage: new MemoryStorage(),
    document,
    makeId: () => ids.shift() ?? "extra-id",
  });
}
