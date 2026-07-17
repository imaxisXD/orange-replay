// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { decodeIngestBody } from "@orange-replay/shared/wire";
import { EventType, type fullSnapshotEvent } from "@orange-replay/rrweb-fork";
import { snapshotInChunks } from "../../rrweb-fork/src/vendor/rrweb-snapshot/index.ts";
import { WorkerSink } from "../src/sink.ts";
import {
  config,
  decoder,
  flushMicrotasks,
  makeCollectingWorkerHost,
  makeSession,
  makeWorkerSink,
  resetSinkTestState,
} from "./sink-test-helpers.ts";

afterEach(resetSinkTestState);

// Regression coverage for docs/specs/fix-zero-duration-sessions.md: a
// session's first upload must carry the initial full-snapshot checkpoint, so
// cadence flushes hold until one is buffered. Without the hold, a Meta-only
// first batch finalizes into an unplayable zero-duration ghost session.
describe("WorkerSink first-upload checkpoint gate", () => {
  it("holds timer flushes until the initial full snapshot is buffered", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 50 }));
    });
    const sink = makeWorkerSink({
      config: { ...config, flushMs: 50 },
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost: makeCollectingWorkerHost(),
    });

    try {
      sink.start();
      sink.addRrwebEvent(makeMetaEvent(1));

      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();
      expect(fetchMock).not.toHaveBeenCalled();

      sink.addRrwebEvent(await makeSnapshotEvent(2));
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = fetchMock.mock.calls[0]?.[1]?.body as Uint8Array;
      const replay = JSON.parse(decoder.decode(decodeIngestBody(body).payload)) as Array<{
        type: number;
      }>;
      expect(replay.map((event) => event.type)).toEqual([EventType.Meta, EventType.FullSnapshot]);
      expect(decodeIngestBody(body).index.checkpointTimestamps).toEqual([2]);
    } finally {
      await sink.stop();
      vi.useRealTimers();
    }
  });

  it("still sends a Meta-only batch at pagehide so a real bounce is recorded", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const sink = makeWorkerSink({
      config,
      session: makeSession(["session-one", "tab-one"]),
      window,
      fetch: fetchMock,
      workerHost: makeCollectingWorkerHost(),
    });

    try {
      sink.start();
      sink.addRrwebEvent(makeMetaEvent(1));
      window.dispatchEvent(new Event("pagehide"));
      await flushMicrotasks();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await sink.stop();
    }
  });

  it("re-arms the hold after a session rotation", async () => {
    vi.useFakeTimers();
    let closeSession = true;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const closed = closeSession;
      closeSession = false;
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 50, closed }));
    });
    const requestCheckpoint = vi.fn();
    const sink = makeWorkerSink({
      config: { ...config, flushMs: 50 },
      session: makeSession(["session-one", "tab-one", "session-two"]),
      window,
      fetch: fetchMock,
      workerHost: makeCollectingWorkerHost(),
      onCheckpointRequested: requestCheckpoint,
    });

    try {
      sink.start();
      sink.addRrwebEvent(makeMetaEvent(1));
      sink.addRrwebEvent(await makeSnapshotEvent(2));
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => expect(requestCheckpoint).toHaveBeenCalledWith(true));

      // The fresh recorder emits Meta first; nothing may flush until its new
      // snapshot lands.
      sink.addRrwebEvent(makeMetaEvent(10));
      await vi.advanceTimersByTimeAsync(200);
      await flushMicrotasks();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      sink.addRrwebEvent(await makeSnapshotEvent(11));
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await sink.stop();
      vi.useRealTimers();
    }
  });
});

function makeMetaEvent(timestamp: number) {
  return {
    type: EventType.Meta,
    timestamp,
    data: { href: "/", width: 1_728, height: 904 },
  } as Parameters<WorkerSink["addRrwebEvent"]>[0];
}

async function makeSnapshotEvent(
  timestamp: number,
): Promise<fullSnapshotEvent & { timestamp: number }> {
  const snapshotDocument = document.implementation.createHTMLDocument("first flush snapshot");
  snapshotDocument.body.appendChild(snapshotDocument.createElement("main"));
  const node = await snapshotInChunks(
    snapshotDocument,
    {},
    { skipPreparation: true, now: () => 0, yieldToMain: async () => undefined },
  );
  if (node === null) throw new Error("Test snapshot was not created.");
  return {
    type: EventType.FullSnapshot,
    timestamp,
    data: { node, initialOffset: { top: 0, left: 0 } },
  };
}
