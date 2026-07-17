// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FLAG_UNCOMPRESSED, HDR_FLAGS, HDR_SEQ } from "@orange-replay/shared/constants";
import { decodeIngestBody } from "@orange-replay/shared/wire";
import {
  EventType,
  getSnapshotEstimatedBytes,
  IncrementalSource,
  type eventWithTime,
  type fullSnapshotEvent,
} from "@orange-replay/rrweb-fork";
import { snapshotInChunks } from "../../rrweb-fork/src/vendor/rrweb-snapshot/index.ts";
import { PAGEHIDE_RAW_FLUSH_BYTES } from "../src/pipeline/batcher.ts";
import { WorkerHost } from "../src/pipeline/worker-host.ts";
import {
  config,
  decoder,
  droppedEventCount,
  flushMicrotasks,
  installSendBeacon,
  makeCollectingWorkerHost,
  makeEvent,
  makePendingWorkerHost,
  makeSession,
  makeWorkerHost,
  makeWorkerSink,
  resetSinkTestState,
} from "./sink-test-helpers.ts";

afterEach(resetSinkTestState);

class PendingWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
}

describe("WorkerSink pagehide final flush", () => {
  it("restarts timed flushes after a BFCache restore", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 50 }));
    });
    const workerHost = makeCollectingWorkerHost();
    const sink = makeWorkerSink({
      config: { ...config, flushMs: 50 },
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost,
    });

    try {
      sink.start();
      sink.addRrwebEvent(makeEvent(1, "before-pagehide"));
      const pagehide = new Event("pagehide");
      Object.defineProperty(pagehide, "persisted", { value: true });
      window.dispatchEvent(pagehide);
      await flushMicrotasks();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const pageshow = new Event("pageshow");
      Object.defineProperty(pageshow, "persisted", { value: true });
      window.dispatchEvent(pageshow);
      sink.addRrwebEvent(makeEvent(2, "after-restore"));
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(workerHost.flushBatch).toHaveBeenCalledOnce();
      const body = fetchMock.mock.calls[1]?.[1]?.body as Uint8Array;
      const replay = JSON.parse(decoder.decode(decodeIngestBody(body).payload));
      expect(replay).toEqual([makeEvent(2, "after-restore")]);
    } finally {
      await sink.stop();
      vi.useRealTimers();
    }
  });

  it("queues a wire-valid uncompressed body synchronously", async () => {
    const sendBeacon = installSendBeacon(() => true);
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({ config, session, window, fetch: fetchMock, workerHost });

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
    const sink = makeWorkerSink({
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
    expect(droppedEventCount(sink)).toBe(1);
  });

  it("does not re-stringify the whole final batch once per dropped event", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({
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
    expect(droppedEventCount(sink)).toBeGreaterThan(0);
  });

  it("keeps total pagehide sync bodies under one keepalive budget", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const workerHost = makeWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(makeEvent(1, "current", "x".repeat(10_000)));
    await sink.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = fetchMock.mock.calls[0]?.[1]?.body as Uint8Array;
    expect(body.byteLength).toBeLessThanOrEqual(PAGEHIDE_RAW_FLUSH_BYTES);
  });

  it("counts a queued keepalive batch as dropped when the fetch later fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network closed"));
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({
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
    expect(droppedEventCount(sink)).toBe(1);
  });

  it("requests a checkpoint after a medium baseline cannot fit the pagehide body", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const requestCheckpoint = vi.fn();
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost: makeWorkerHost(),
      onCheckpointRequested: requestCheckpoint,
    });
    const baseline = await makeBaseline(800);
    const baselineBytes = getSnapshotEstimatedBytes(baseline.data.node) ?? 0;
    expect(baselineBytes).toBeGreaterThan(PAGEHIDE_RAW_FLUSH_BYTES);
    expect(baselineBytes).toBeLessThan(128 * 1024);

    sink.start();
    sink.addRrwebEvent(baseline);
    const pagehide = new Event("pagehide");
    Object.defineProperty(pagehide, "persisted", { value: true });
    window.dispatchEvent(pagehide);
    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestCheckpoint).not.toHaveBeenCalled();

    const pageshow = new Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    await flushMicrotasks();

    expect(requestCheckpoint).toHaveBeenCalledOnce();
    expect(requestCheckpoint).toHaveBeenCalledWith(true);
    await sink.stop();
  });

  it("requests a checkpoint when a required keepalive later rejects", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network closed"));
    const requestCheckpoint = vi.fn();
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost: makeWorkerHost(),
      onCheckpointRequested: requestCheckpoint,
    });
    const baseline = await makeBaseline(100);
    expect(getSnapshotEstimatedBytes(baseline.data.node)).toBeLessThan(PAGEHIDE_RAW_FLUSH_BYTES);

    sink.start();
    sink.addRrwebEvent(baseline);
    const pagehide = new Event("pagehide");
    Object.defineProperty(pagehide, "persisted", { value: true });
    window.dispatchEvent(pagehide);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestCheckpoint).not.toHaveBeenCalled();

    const pageshow = new Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    await flushMicrotasks();

    expect(requestCheckpoint).toHaveBeenCalledOnce();
    expect(requestCheckpoint).toHaveBeenCalledWith(true);
    await sink.stop();
  });

  it("blocks an in-flight iframe snapshot while replacing an unsettled baseline", async () => {
    let rejectKeepalive: ((reason?: unknown) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectKeepalive = reject;
        }),
    );
    const requestCheckpoint = vi.fn();
    const pendingWorker = makePendingWorkerHost();
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost: pendingWorker.workerHost,
      onCheckpointRequested: requestCheckpoint,
    });
    const baseline = await makeBaseline(100);

    sink.start();
    sink.addRrwebEvent(baseline);
    const pagehide = new Event("pagehide");
    Object.defineProperty(pagehide, "persisted", { value: true });
    window.dispatchEvent(pagehide);
    expect(fetchMock).toHaveBeenCalledOnce();

    const iframeAttachment = {
      type: EventType.IncrementalSnapshot,
      timestamp: 20,
      data: {
        source: IncrementalSource.Mutation,
        adds: [{ parentId: 1, nextId: null, node: baseline.data.node }],
        removes: [],
        texts: [],
        attributes: [],
        isAttachIframe: true,
      },
    } as eventWithTime;
    sink.addRrwebEvent(iframeAttachment);
    const dependentFlush = sink.flush("manual");
    await flushMicrotasks();
    expect(pendingWorker.workerHost.flushBatch).toHaveBeenCalledOnce();

    const pageshow = new Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    expect(requestCheckpoint).not.toHaveBeenCalled();

    pendingWorker.resolve({
      payload: new TextEncoder().encode(JSON.stringify([iframeAttachment])),
      uncompressed: true,
    });
    await dependentFlush;
    expect(requestCheckpoint).toHaveBeenCalledOnce();
    expect(requestCheckpoint).toHaveBeenCalledWith(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    rejectKeepalive?.(new Error("network closed after restore"));
    await flushMicrotasks();
    expect(requestCheckpoint).toHaveBeenCalledOnce();
    expect(droppedEventCount(sink)).toBe(2);
    await sink.stop();
  });

  it("keeps an in-flight baseline when pagehide happens before the worker replies", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const pendingWorker = makePendingWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost: pendingWorker.workerHost,
    });
    const baseline = {
      type: 2,
      timestamp: 10,
      data: {
        node: { type: 0, id: 1, childNodes: [] },
        initialOffset: { top: 0, left: 0 },
      },
    } as Parameters<typeof sink.addRrwebEvent>[0];

    sink.addRrwebEvent(baseline);
    await flushMicrotasks();
    const finalFlush = sink.flush("pagehide");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
    const finalBody = fetchMock.mock.calls[0]?.[1]?.body as Uint8Array;
    const finalEvents = JSON.parse(decoder.decode(decodeIngestBody(finalBody).payload));
    expect(finalEvents).toEqual([baseline]);

    pendingWorker.resolve({
      payload: new TextEncoder().encode(JSON.stringify([baseline])),
      uncompressed: true,
    });
    await finalFlush;
  });

  it("keeps recording after pagehide cancels a real pending worker flush", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const onWorkerUnavailable = vi.fn();
    const workerHost = new WorkerHost({
      WorkerCtor: PendingWorker as unknown as typeof Worker,
      createObjectUrl: () => "blob:orange-replay-worker",
      revokeObjectUrl: vi.fn(),
      warn: vi.fn(),
    });
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost,
      onWorkerUnavailable,
    });

    sink.addRrwebEvent(makeEvent(10, "in-flight"));
    const pendingFlush = sink.flush("manual");
    await flushMicrotasks();
    sink.addRrwebEvent(makeEvent(11, "at-pagehide"));
    await Promise.all([pendingFlush, sink.flush("pagehide")]);

    expect(onWorkerUnavailable).not.toHaveBeenCalled();
    expect(sink.isAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    sink.addRrwebEvent(makeEvent(12, "after-restore"));
    await sink.flush("pagehide");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await sink.stop();
  });

  it("does not stringify or persist mutations without an oversized in-flight baseline", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const pendingWorker = makePendingWorkerHost();
    const requestCheckpoint = vi.fn();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost: pendingWorker.workerHost,
      onCheckpointRequested: requestCheckpoint,
    });
    const baseline = await makeOversizedBaseline();
    expect(getSnapshotEstimatedBytes(baseline.data.node)).toBeGreaterThan(PAGEHIDE_RAW_FLUSH_BYTES);
    const stringifySpy = vi.spyOn(JSON, "stringify");

    sink.addRrwebEvent(baseline);
    const inFlight = sink.flush("manual");
    await flushMicrotasks();
    expect(pendingWorker.workerHost.flushBatch).toHaveBeenCalledTimes(1);
    sink.addRrwebEvent(makeEvent(11, "after-baseline"));
    sink.start();
    const finalFlush = sink.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      stringifySpy.mock.calls.some(
        ([value]) => Array.isArray(value) && value.some((event) => event === baseline),
      ),
    ).toBe(false);
    expect(droppedEventCount(sink)).toBe(2);

    pendingWorker.resolve({
      payload: new TextEncoder().encode("[]"),
      uncompressed: true,
    });
    await Promise.all([inFlight, finalFlush]);
    const pageshow = new Event("pageshow");
    Object.defineProperty(pageshow, "persisted", { value: true });
    window.dispatchEvent(pageshow);
    await flushMicrotasks();
    expect(requestCheckpoint).toHaveBeenCalledOnce();
    expect(requestCheckpoint).toHaveBeenCalledWith(true);
    await sink.stop();
  });

  it("does not persist iframe mutations without an oversized iframe attachment", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const pendingWorker = makePendingWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = makeWorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost: pendingWorker.workerHost,
    });
    const fullSnapshot = await makeOversizedBaseline();
    const iframeAttachment = {
      type: EventType.IncrementalSnapshot,
      timestamp: 20,
      data: {
        source: IncrementalSource.Mutation,
        adds: [{ parentId: 8, nextId: null, node: fullSnapshot.data.node }],
        removes: [],
        texts: [],
        attributes: [],
        isAttachIframe: true,
      },
    } as eventWithTime;
    const iframeMutation = {
      type: EventType.IncrementalSnapshot,
      timestamp: 21,
      data: {
        source: IncrementalSource.Mutation,
        adds: [],
        removes: [],
        texts: [{ id: 2, value: "changed" }],
        attributes: [],
      },
    } as eventWithTime;

    sink.addRrwebEvent(iframeAttachment);
    const inFlight = sink.flush("manual");
    await flushMicrotasks();
    expect(pendingWorker.workerHost.flushBatch).toHaveBeenCalledTimes(1);
    sink.addRrwebEvent(iframeMutation);
    const finalFlush = sink.flush("pagehide");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(droppedEventCount(sink)).toBe(2);

    pendingWorker.resolve({
      payload: new TextEncoder().encode("[]"),
      uncompressed: true,
    });
    await Promise.all([inFlight, finalFlush]);
  });
});

async function makeOversizedBaseline(): Promise<fullSnapshotEvent & { timestamp: number }> {
  return makeBaseline(2_000);
}

async function makeBaseline(rowCount: number): Promise<fullSnapshotEvent & { timestamp: number }> {
  const snapshotDocument = document.implementation.createHTMLDocument("large snapshot");
  const rows = snapshotDocument.createDocumentFragment();
  for (let index = 0; index < rowCount; index += 1) {
    const row = snapshotDocument.createElement("div");
    row.dataset.row = String(index);
    rows.appendChild(row);
  }
  snapshotDocument.body.appendChild(rows);
  const node = await snapshotInChunks(
    snapshotDocument,
    {},
    { skipPreparation: true, now: () => 0, yieldToMain: async () => undefined },
  );
  if (node === null) throw new Error("Large test snapshot was not created.");
  return {
    type: EventType.FullSnapshot,
    timestamp: 10,
    data: { node, initialOffset: { top: 0, left: 0 } },
  };
}
