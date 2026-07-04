import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BatchIndex } from "@orange-replay/shared/types";
import { Transport } from "../src/pipeline/transport.ts";
import type { RecorderConfig } from "../src/types.ts";

const config: RecorderConfig = {
  key: "write-key",
  ingestUrl: "https://ingest.test",
  projectRef: "write-key",
  transport: "worker",
  sampleRate: 1,
  allowUrlParams: [],
  flushMs: 15_000,
};

const index: BatchIndex = {
  v: 1,
  s: "session-one",
  tab: "tab-one",
  seq: 0,
  t0: 1,
  t1: 1,
  e: [],
  u: "/",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Transport", () => {
  it("retries 5xx responses with exponential backoff", async () => {
    const waits: number[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, live: false, flushMs: 7_000 })),
      );
    const transport = new Transport({
      config,
      fetch: fetchMock,
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    const result = await transport.sendBatch({
      body: new Uint8Array([1, 2, 3]),
      index,
      flags: 0,
      keepalive: false,
    });

    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(3);
    expect(waits).toEqual([2_000, 4_000]);
  });

  it("drops 4xx responses without retrying", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("bad key", { status: 401 }));
    const transport = new Transport({ config, fetch: fetchMock });

    const result = await transport.sendBatch({
      body: new Uint8Array([1]),
      index,
      flags: 0,
      keepalive: false,
    });

    expect(result).toMatchObject({ sent: false, dropped: true, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a 202 drop ack as success", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000, drop: true }), {
        status: 202,
      }),
    );
    const transport = new Transport({ config, fetch: fetchMock });

    const result = await transport.sendBatch({
      body: new Uint8Array([1]),
      index,
      flags: 0,
      keepalive: false,
    });

    expect(result.sent).toBe(true);
    expect(result.ack?.drop).toBe(true);
  });

  it("surfaces closed acks through the rotation callback", async () => {
    const onClosed = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000, closed: true })),
      );
    const transport = new Transport({ config, fetch: fetchMock, onClosed });

    await transport.sendBatch({
      body: new Uint8Array([1]),
      index,
      flags: 0,
      keepalive: false,
    });

    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("queues sync batches with fetch first and does not also send a beacon", () => {
    const sendBeacon = vi.fn(() => true);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 })));
    const transport = new Transport({
      config,
      fetch: fetchMock,
    });
    vi.stubGlobal("navigator", { sendBeacon });

    const queued = transport.queueBatchSync({
      body: new Uint8Array([1]),
      index,
      flags: 0,
      keepalive: true,
    });

    expect(queued).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("does not report a failed keepalive fetch as sent through sendBeacon", async () => {
    const sendBeacon = vi.fn(() => true);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network failed"));
    vi.stubGlobal("navigator", { sendBeacon });
    const transport = new Transport({
      config,
      fetch: fetchMock,
      wait: async () => undefined,
    });

    const result = await transport.sendBatch({
      body: new Uint8Array([1]),
      index,
      flags: 0,
      keepalive: true,
    });

    expect(result).toMatchObject({ sent: false, dropped: true, attempts: 5 });
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("counts a sync keepalive setup failure as not queued", () => {
    const transport = new Transport({
      config,
      fetch: vi.fn<typeof fetch>(() => {
        throw new Error("keepalive rejected");
      }),
    });

    expect(
      transport.queueBatchSync({
        body: new Uint8Array([1]),
        index,
        flags: 0,
        keepalive: true,
      }),
    ).toBe(false);
  });

  it("reports an async keepalive failure to the caller", async () => {
    const onFailure = vi.fn();
    const transport = new Transport({
      config,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("later failure")),
    });

    expect(
      transport.queueBatchSync(
        {
          body: new Uint8Array([1]),
          index,
          flags: 0,
          keepalive: true,
        },
        onFailure,
      ),
    ).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
