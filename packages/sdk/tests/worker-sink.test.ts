// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { decodeIngestBody } from "@orange-replay/shared/wire";
import { EventType, IncrementalSource, type eventWithTime } from "@orange-replay/rrweb-fork";
import { snapshotInChunks } from "../../rrweb-fork/src/vendor/rrweb-snapshot/index.ts";
import { BackpressureController, SDK_BUFFER_CAP_BYTES } from "../src/pipeline/backpressure.ts";
import { estimateRrwebEventBytes } from "../src/pipeline/batcher.ts";
import type { WorkerBatchResult } from "../src/pipeline/worker-core.ts";
import type { WorkerHost } from "../src/pipeline/worker-host.ts";
import { WorkerSink } from "../src/sink.ts";
import {
  config,
  decoder,
  droppedEventCount,
  flushMicrotasks,
  makeCollectingWorkerHost,
  makeEvent,
  MemoryCookieDocument,
  makePendingWorkerHost,
  makeResolvedWorkerHost,
  makeSession,
  makeWorkerSink,
  resetSinkTestState,
} from "./sink-test-helpers.ts";

afterEach(resetSinkTestState);

describe("WorkerSink unavailable path", () => {
  it("stops instead of serializing on the main thread when Worker is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 7_000 }));
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({ config, session, window, fetch: fetchMock });

    sink.addRrwebEvent({ type: 0, timestamp: 10, data: { href: "/home" } } as eventWithTime);
    sink.addIndexEvent({ t: 12, k: "click", d: "button#buy", m: { x: 0.5, y: 0.25 } });
    await sink.flush("manual");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "or:disabled Worker blocked; recording stopped. Allow worker-src blob: in CSP.",
    );
  });

  it("posts rrweb events to the worker in one microtask batch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeResolvedWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(1, "one"));
    sink.addRrwebEvent(makeEvent(2, "two"));
    sink.addRrwebEvent(makeEvent(3, "three"));
    await flushMicrotasks();

    expect(workerHost.addEvents).toHaveBeenCalledTimes(1);
    expect(workerHost.addEvents.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it("stops before buffering one structural event above the memory cap", () => {
    const workerHost = makeResolvedWorkerHost();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onWorkerUnavailable = vi.fn();
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      workerHost,
      fetch: vi.fn<typeof fetch>(),
      onWorkerUnavailable,
    });

    sink.addRrwebEvent({
      type: EventType.IncrementalSnapshot,
      timestamp: 1,
      data: {
        source: IncrementalSource.Mutation,
        texts: [],
        attributes: [{ id: 1, attributes: { class: "x".repeat(4 * 1024 * 1024) } }],
        removes: [],
        adds: [],
      },
    } as eventWithTime);

    expect(workerHost.addEvents).not.toHaveBeenCalled();
    expect(workerHost.stop).toHaveBeenCalledOnce();
    expect(onWorkerUnavailable).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps a worker batch charged until the worker finishes", async () => {
    let rejectWorker: (error: Error) => void = () => undefined;
    const pendingWorker = new Promise<WorkerBatchResult>((_resolve, reject) => {
      rejectWorker = reject;
    });
    const addEvents = vi.fn();
    const flushBatch = vi.fn(() => pendingWorker);
    const stop = vi.fn(() => rejectWorker(new Error("worker stopped")));
    const workerHost = {
      addEvents,
      flushBatch,
      reset: vi.fn(),
      stop,
    } as unknown as WorkerHost;
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      workerHost,
      fetch: vi.fn<typeof fetch>(),
    });
    const pressure = new BackpressureController(800);
    Object.defineProperty(sink, "backpressure", { value: pressure });

    sink.addRrwebEvent(makeEvent(1, "first"));
    const flush = sink.flush("manual");
    for (let attempt = 0; attempt < 10 && flushBatch.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(pressure.bufferedBytes()).toBe(512);
    sink.addRrwebEvent(makeEvent(2, "overflow"));
    await flush;

    expect(stop).toHaveBeenCalledOnce();
    expect(addEvents).toHaveBeenCalledTimes(1);
    expect(pressure.bufferedBytes()).toBe(0);
  });

  it("keeps a live event while an oversized baseline is in flight", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const pendingWorker = makePendingWorkerHost();
    const onWorkerUnavailable = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost: pendingWorker.workerHost,
      onWorkerUnavailable,
    });
    const baseline = await makeOversizedBaseline();

    sink.addRrwebEvent(baseline);
    const baselineFlush = sink.flush("manual");
    await flushMicrotasks();
    sink.addRrwebEvent(makeEvent(11, "after-baseline"));
    await flushMicrotasks();

    expect(pendingWorker.workerHost.stop).not.toHaveBeenCalled();
    expect(onWorkerUnavailable).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(pendingWorker.workerHost.addEvents).toHaveBeenCalledTimes(2);

    pendingWorker.resolve({ payload: new TextEncoder().encode("[]"), uncompressed: true });
    await baselineFlush;
    await sink.flush("manual");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(droppedEventCount(sink)).toBe(0);
  });

  it("recovers with a fresh checkpoint after oversized catch-up overflows", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const pendingWorker = makePendingWorkerHost();
    const requestCheckpoint = vi.fn();
    const onWorkerUnavailable = vi.fn();
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost: pendingWorker.workerHost,
      onCheckpointRequested: requestCheckpoint,
      onWorkerUnavailable,
    });

    sink.addRrwebEvent(await makeOversizedBaseline());
    const baselineFlush = sink.flush("manual");
    await flushMicrotasks();
    sink.addRrwebEvent(makeEvent(11, "kept-catch-up", "x".repeat(10_000)));
    sink.addRrwebEvent({
      type: EventType.IncrementalSnapshot,
      timestamp: 12,
      data: {
        source: IncrementalSource.Mutation,
        texts: [],
        attributes: [{ id: 1, attributes: { class: "x".repeat(80_000) } }],
        removes: [],
        adds: [],
      },
    } as eventWithTime);
    sink.addRrwebEvent(makeEvent(13, "after-gap"));

    expect(requestCheckpoint).not.toHaveBeenCalled();
    expect(onWorkerUnavailable).not.toHaveBeenCalled();
    expect(pendingWorker.workerHost.stop).not.toHaveBeenCalled();

    pendingWorker.resolve({ payload: new TextEncoder().encode("[]"), uncompressed: true });
    await baselineFlush;
    await sink.flush("manual");

    expect(requestCheckpoint).toHaveBeenCalledOnce();
    expect(requestCheckpoint).toHaveBeenCalledWith(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(droppedEventCount(sink)).toBe(2);
    expect(onWorkerUnavailable).not.toHaveBeenCalled();
  });

  it("sends a large page and two oversized iframe baselines one at a time", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeResolvedWorkerHost();
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost,
    });
    const mainBaseline = await makeMediumBaseline();
    const oversizedBaseline = await makeOversizedBaseline();
    const firstIframe = makeIframeBaseline(oversizedBaseline, 11, 10);
    const secondIframe = makeIframeBaseline(oversizedBaseline, 12, 20);

    await sink.prepareForSnapshotPart(estimateRrwebEventBytes(mainBaseline));
    sink.addRrwebEvent(mainBaseline);
    await sink.prepareForSnapshotPart(estimateRrwebEventBytes(firstIframe));
    sink.addRrwebEvent(firstIframe);
    await sink.prepareForSnapshotPart(estimateRrwebEventBytes(secondIframe));
    sink.addRrwebEvent(secondIframe);
    await sink.prepareForSnapshotPart();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(workerHost.stop).not.toHaveBeenCalled();
    expect(droppedEventCount(sink)).toBe(0);
  });
});

describe("WorkerSink session rotation", () => {
  it("owns drain, rotate, reset, and required-snapshot order", async () => {
    const bodies: Uint8Array[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeCollectingWorkerHost();
    const cookies = new MemoryCookieDocument();
    const session = makeSession(["owner-session-0001", "tab-one", "owner-session-0002"], cookies);
    cookies.clear();
    let sink: WorkerSink;
    const requestCheckpoint = vi.fn((required?: boolean) => {
      expect(required).toBe(true);
      expect(session.sessionId).toBe("owner-session-0002");
      expect(workerHost.reset).toHaveBeenCalledOnce();
      sink.addRrwebEvent(makeFullSnapshot(2));
    });
    sink = makeWorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost,
      onCheckpointRequested: requestCheckpoint,
    });

    sink.addRrwebEvent(makeEvent(1, "old-session"));
    sink.resumeSessionAfterIdle();
    await vi.waitFor(() => expect(requestCheckpoint).toHaveBeenCalledOnce());
    await sink.flush("manual");

    expect(bodies).toHaveLength(2);
    const oldBatch = decodeIngestBody(bodies[0] ?? new Uint8Array());
    const newBatch = decodeIngestBody(bodies[1] ?? new Uint8Array());
    expect(oldBatch.index).toMatchObject({ s: "owner-session-0001", seq: 0 });
    expect(newBatch.index).toMatchObject({ s: "owner-session-0002", seq: 0 });
    expect(newBatch.index.checkpointTimestamps).toEqual([2]);
    expect(JSON.parse(decoder.decode(newBatch.payload))[0]).toMatchObject({
      type: EventType.FullSnapshot,
    });
    expect(workerHost.reset).toHaveBeenCalledTimes(1);
  });

  it("keeps the pipeline when idle reconciliation keeps the active cookie", async () => {
    const workerHost = makeCollectingWorkerHost();
    const cookies = new MemoryCookieDocument();
    const session = makeSession(["same-cookie-0001", "tab-one", "same-cookie-0002"], cookies);
    const resumeAfterIdle = vi.spyOn(session, "resumeAfterIdle");
    const requestCheckpoint = vi.fn();
    const sink = makeWorkerSink({
      config,
      session,
      window,
      fetch: vi.fn<typeof fetch>(),
      workerHost,
      onCheckpointRequested: requestCheckpoint,
    });

    sink.resumeSessionAfterIdle();
    await vi.waitFor(() => expect(resumeAfterIdle).toHaveBeenCalledOnce());

    expect(session.sessionId).toBe("same-cookie-0001");
    expect(workerHost.reset).not.toHaveBeenCalled();
    expect(requestCheckpoint).not.toHaveBeenCalled();
  });

  it("lets a closed ack win and completes the bounded old-session drain", async () => {
    const bodies: Uint8Array[] = [];
    let finishFirstRequest: (response: Response) => void = () => undefined;
    const firstRequest = new Promise<Response>((resolve) => {
      finishFirstRequest = resolve;
    });
    let requestNumber = 0;
    let finishSecondRequest: (response: Response) => void = () => undefined;
    const secondRequest = new Promise<Response>((resolve) => {
      finishSecondRequest = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(init?.body as Uint8Array);
      requestNumber += 1;
      if (requestNumber === 1) return firstRequest;
      if (requestNumber === 2) return secondRequest;
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeCollectingWorkerHost();
    const cookies = new MemoryCookieDocument();
    const session = makeSession(
      ["collision-old-0001", "tab-one", "collision-new-0002", "collision-spare-0003"],
      cookies,
    );
    cookies.clear();
    const resumeAfterIdle = vi.spyOn(session, "resumeAfterIdle");
    const rotate = vi.spyOn(session, "rotate");
    let sink: WorkerSink;
    const requestCheckpoint = vi.fn(() => sink.addRrwebEvent(makeFullSnapshot(3)));
    sink = makeWorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost,
      onCheckpointRequested: requestCheckpoint,
    });

    sink.addRrwebEvent(makeEvent(1, "old-session"));
    const activeFlush = sink.flush("manual");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    sink.resumeSessionAfterIdle();
    sink.addRrwebEvent(makeEvent(2, "old-session-tail"));
    finishFirstRequest(
      new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000, closed: true })),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    sink.addRrwebEvent(makeEvent(2.5, "capture-stays-active"));
    finishSecondRequest(new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 })));
    await activeFlush;
    await vi.waitFor(() => expect(requestCheckpoint).toHaveBeenCalledOnce());
    await sink.flush("manual");

    expect(resumeAfterIdle).not.toHaveBeenCalled();
    expect(rotate).toHaveBeenCalledOnce();
    expect(workerHost.reset).toHaveBeenCalledOnce();
    expect(bodies).toHaveLength(3);
    expect(bodies.slice(0, 2).map((body) => decodeIngestBody(body).index.s)).toEqual([
      "collision-old-0001",
      "collision-old-0001",
    ]);
    expect(
      bodies.some((body) =>
        decoder.decode(decodeIngestBody(body).payload).includes("capture-stays-active"),
      ),
    ).toBe(false);
    expect(decodeIngestBody(bodies[2] ?? new Uint8Array()).index).toMatchObject({
      s: "collision-new-0002",
      seq: 0,
      checkpointTimestamps: [3],
    });
  });

  it("does not rotate when stop wins during the old-session drain", async () => {
    let finishRequest: (response: Response) => void = () => undefined;
    const request = new Promise<Response>((resolve) => {
      finishRequest = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(() => request);
    const workerHost = makeCollectingWorkerHost();
    const session = makeSession(["stop-session-0001", "tab-one", "stop-session-0002"]);
    const rotate = vi.spyOn(session, "rotate");
    const requestCheckpoint = vi.fn();
    const sink = makeWorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost,
      onCheckpointRequested: requestCheckpoint,
    });

    sink.addRrwebEvent(makeEvent(1, "old-session"));
    sink.resumeSessionAfterIdle();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const stopping = sink.stop();
    finishRequest(new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 })));
    await stopping;
    await flushMicrotasks();

    expect(rotate).not.toHaveBeenCalled();
    expect(session.sessionId).toBe("stop-session-0001");
    expect(requestCheckpoint).not.toHaveBeenCalled();
  });
});

describe("WorkerSink stop drain", () => {
  it("waits for an active flush and then sends the buffered tail before stopping", async () => {
    const firstEvent = makeEvent(1, "first");
    const tailEvent = makeEvent(2, "tail");
    const ignoredAfterStop = makeEvent(3, "ignored");
    const pendingResults: ((result: WorkerBatchResult) => void)[] = [];
    const flushBatch = vi.fn(
      () =>
        new Promise<WorkerBatchResult>((resolve) => {
          pendingResults.push(resolve);
        }),
    );
    const stopWorker = vi.fn();
    const workerHost = {
      addEvents: vi.fn(),
      flushBatch,
      reset: vi.fn(),
      stop: stopWorker,
    } as unknown as WorkerHost;
    const bodies: Uint8Array[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      workerHost,
      fetch: fetchMock,
    });

    sink.addRrwebEvent(firstEvent);
    const activeFlush = sink.flush("manual");
    await vi.waitFor(() => expect(flushBatch).toHaveBeenCalledTimes(1));
    sink.addRrwebEvent(tailEvent);
    const stopping = sink.stop();
    sink.addRrwebEvent(ignoredAfterStop);
    expect(stopWorker).not.toHaveBeenCalled();

    pendingResults[0]?.({
      payload: new TextEncoder().encode(JSON.stringify([firstEvent])),
      uncompressed: true,
    });
    await vi.waitFor(() => expect(flushBatch).toHaveBeenCalledTimes(2));
    expect(stopWorker).not.toHaveBeenCalled();

    pendingResults[1]?.({
      payload: new TextEncoder().encode(JSON.stringify([tailEvent])),
      uncompressed: true,
    });
    await Promise.all([activeFlush, stopping]);

    expect(stopWorker).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      bodies.map((body) => JSON.parse(decoder.decode(decodeIngestBody(body).payload))),
    ).toEqual([[firstEvent], [tailEvent]]);
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
    const sink = makeWorkerSink({
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
    const sink = makeWorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(10, "before-drop"));
    await sink.flush("manual");
    sink.addRrwebEvent(makeEvent(11, "after-drop"));
    await sink.flush("manual");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workerHost.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending session change when a server drop wins", async () => {
    let finishRequest: (response: Response) => void = () => undefined;
    const request = new Promise<Response>((resolve) => {
      finishRequest = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(() => request);
    const workerHost = makeResolvedWorkerHost();
    const session = makeSession(["drop-session-0001", "tab-one", "drop-session-0002"]);
    const rotate = vi.spyOn(session, "rotate");
    const requestCheckpoint = vi.fn();
    const sink = makeWorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost,
      onCheckpointRequested: requestCheckpoint,
    });

    sink.addRrwebEvent(makeEvent(10, "before-drop"));
    const activeFlush = sink.flush("manual");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    sink.resumeSessionAfterIdle();
    finishRequest(
      new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000, drop: true }), {
        status: 202,
      }),
    );
    await activeFlush;
    await flushMicrotasks();

    expect(rotate).not.toHaveBeenCalled();
    expect(session.sessionId).toBe("drop-session-0001");
    expect(requestCheckpoint).not.toHaveBeenCalled();
  });

  it("counts batches dropped by transport failures", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("bad key", { status: 401 }));
    const workerHost = makeResolvedWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(10, "dropped"));
    await sink.flush("manual");

    expect(droppedEventCount(sink)).toBe(1);
  });

  it("requests a replacement checkpoint when transport drops a required baseline", async () => {
    const requestCheckpoint = vi.fn();
    let finishRequest: (response: Response) => void = () => undefined;
    const request = new Promise<Response>((resolve) => {
      finishRequest = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(() => request);
    const workerHost = makeResolvedWorkerHost();
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost,
      onCheckpointRequested: requestCheckpoint,
    });

    sink.addRrwebEvent({
      type: EventType.FullSnapshot,
      timestamp: 10,
      data: { node: { id: 1, type: 0 }, initialOffset: { left: 0, top: 0 } },
    } as eventWithTime);
    const flush = sink.flush("manual");
    await flushMicrotasks();
    sink.addRrwebEvent(makeEvent(11, "depends-on-missing-baseline"));
    finishRequest(new Response("bad key", { status: 401 }));
    await flush;

    expect(requestCheckpoint).toHaveBeenCalledOnce();
    expect(requestCheckpoint).toHaveBeenCalledWith(true);
    expect(workerHost.reset).toHaveBeenCalledOnce();
    expect(droppedEventCount(sink)).toBe(2);
  });
});

function makeFullSnapshot(timestamp: number): eventWithTime {
  return {
    type: EventType.FullSnapshot,
    timestamp,
    data: { node: { id: 1, type: 0 }, initialOffset: { left: 0, top: 0 } },
  } as eventWithTime;
}

function makeIframeBaseline(
  baseline: eventWithTime,
  timestamp: number,
  parentId: number,
): eventWithTime {
  if (baseline.type !== EventType.FullSnapshot) throw new Error("Expected a full snapshot.");
  return {
    type: EventType.IncrementalSnapshot,
    timestamp,
    data: {
      source: IncrementalSource.Mutation,
      texts: [],
      attributes: [],
      removes: [],
      adds: [{ parentId, nextId: null, node: baseline.data.node }],
      isAttachIframe: true,
    },
  } as eventWithTime;
}

async function makeMediumBaseline(): Promise<eventWithTime> {
  const event = await makeBaseline(4, 20_000, "large page");
  expect(estimateRrwebEventBytes(event)).toBeGreaterThan(128 * 1024);
  expect(estimateRrwebEventBytes(event)).toBeLessThan(SDK_BUFFER_CAP_BYTES);
  return event;
}

async function makeOversizedBaseline(): Promise<eventWithTime> {
  const event = await makeBaseline(64, 40_000, "oversized baseline");
  expect(estimateRrwebEventBytes(event)).toBeGreaterThan(SDK_BUFFER_CAP_BYTES);
  return event;
}

async function makeBaseline(
  rowCount: number,
  textLength: number,
  title: string,
): Promise<eventWithTime> {
  const snapshotDocument = document.implementation.createHTMLDocument(title);
  const rows = snapshotDocument.createDocumentFragment();
  for (let index = 0; index < rowCount; index += 1) {
    const row = snapshotDocument.createElement("p");
    row.textContent = "x".repeat(textLength);
    rows.appendChild(row);
  }
  snapshotDocument.body.appendChild(rows);
  const node = await snapshotInChunks(
    snapshotDocument,
    {},
    { skipPreparation: true, now: () => 0, yieldToMain: async () => undefined },
  );
  if (node === null) throw new Error("Oversized test baseline was not created.");
  const event = {
    type: EventType.FullSnapshot,
    timestamp: 10,
    data: {
      node,
      initialOffset: { top: 0, left: 0 },
    },
  } as eventWithTime;
  return event;
}
