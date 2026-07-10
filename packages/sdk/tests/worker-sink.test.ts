// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FLAG_UNCOMPRESSED, HDR_FLAGS } from "@orange-replay/shared/constants";
import { decodeIngestBody } from "@orange-replay/shared/wire";
import { EventType, type eventWithTime } from "@orange-replay/rrweb-fork";
import { WorkerSink } from "../src/sink.ts";
import {
  config,
  decoder,
  flushMicrotasks,
  gunzipToText,
  makeCollectingWorkerHost,
  makeEvent,
  makeResolvedWorkerHost,
  makeSession,
  resetSinkTestState,
} from "./sink-test-helpers.ts";

afterEach(resetSinkTestState);

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
    expect(newBatch.index.checkpointTimestamps).toEqual([2]);
    expect(JSON.parse(decoder.decode(newBatch.payload))[0]).toMatchObject({
      type: EventType.FullSnapshot,
    });
    expect(workerHost.reset).toHaveBeenCalledTimes(1);
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
