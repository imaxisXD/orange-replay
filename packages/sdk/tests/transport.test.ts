import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BatchIndex } from "@orange-replay/shared/types";
import { readAck, Transport } from "../src/pipeline/transport.ts";
import type { RecorderConfig } from "../src/types.ts";

const config: RecorderConfig = {
  key: "write-key",
  ingestUrl: "https://ingest.test",
  projectRef: "write-key",
  transport: "worker",
  sampleRate: 1,
  maskPolicyVersion: 0,
  capture: { heatmaps: false, console: false, network: false, canvas: false },
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
  vi.useRealTimers();
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

  it("retries 429 responses and honors Retry-After", async () => {
    const waits: number[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "3" } }))
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
      body: new Uint8Array([1]),
      index,
      flags: 0,
      keepalive: false,
    });

    expect(result).toMatchObject({ sent: true, dropped: false, attempts: 2 });
    expect(waits).toEqual([3_000]);
  });

  it("aborts requests that never return", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")));
      });
    });
    const transport = new Transport({
      config,
      fetch: fetchMock,
      wait: async () => undefined,
    });

    const resultPromise = transport.sendBatch({
      body: new Uint8Array([1]),
      index,
      flags: 0,
      keepalive: false,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({ sent: false, dropped: true, attempts: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      fetchMock.mock.calls.every((call) => (call[1]?.signal as AbortSignal | undefined)?.aborted),
    ).toBe(true);
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

  it("keeps closed acks in the parsed response for the sink owner", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000, closed: true })),
      );
    const transport = new Transport({ config, fetch: fetchMock });

    const result = await transport.sendBatch({
      body: new Uint8Array([1]),
      index,
      flags: 0,
      keepalive: false,
    });

    expect(result.ack?.closed).toBe(true);
  });

  it("keeps checkpoint acks in the parsed response", async () => {
    const ack = await readAck(
      new Response(JSON.stringify({ ok: true, live: true, flushMs: 4_000, checkpoint: true })),
    );

    expect(ack).toMatchObject({ ok: true, live: true, flushMs: 4_000, checkpoint: true });
  });

  it("queues sync batches with fetch first and reports delivery", async () => {
    const sendBeacon = vi.fn(() => true);
    const onSuccess = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 })));
    const transport = new Transport({
      config,
      fetch: fetchMock,
    });
    vi.stubGlobal("navigator", { sendBeacon });

    const queued = transport.queueBatchSync(
      {
        body: new Uint8Array([1]),
        index,
        flags: 0,
        keepalive: true,
      },
      undefined,
      onSuccess,
    );

    expect(queued).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendBeacon).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSuccess).toHaveBeenCalledOnce();
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
