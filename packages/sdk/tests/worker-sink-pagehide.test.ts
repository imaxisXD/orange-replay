// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FLAG_UNCOMPRESSED, HDR_FLAGS, HDR_SEQ } from "@orange-replay/shared/constants";
import { decodeIngestBody } from "@orange-replay/shared/wire";
import { PAGEHIDE_RAW_FLUSH_BYTES } from "../src/pipeline/batcher.ts";
import { WorkerSink } from "../src/sink.ts";
import {
  config,
  decoder,
  flushMicrotasks,
  installSendBeacon,
  makeEvent,
  makeSession,
  makeWorkerHost,
  resetSinkTestState,
} from "./sink-test-helpers.ts";

afterEach(resetSinkTestState);

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
