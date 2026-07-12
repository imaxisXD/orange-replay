// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkerSink } from "../src/sink.ts";
import {
  config,
  droppedEventCount,
  installSendBeacon,
  makeEvent,
  makeFailingWorkerHost,
  makePendingWorkerHost,
  makeRetryWorkerHost,
  makeSession,
  resetSinkTestState,
} from "./sink-test-helpers.ts";

afterEach(resetSinkTestState);

describe("WorkerSink worker failures", () => {
  it("does not retry a rejected worker flush on the main thread", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const event = makeEvent(10, "retry");
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const workerHost = makeRetryWorkerHost(event);
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({ config, session, window, fetch: fetchMock, workerHost });

    sink.addRrwebEvent(event);
    await sink.flush("manual");

    expect(workerHost.reset).not.toHaveBeenCalled();
    expect(workerHost.addEvents).toHaveBeenCalledTimes(1);
    expect(workerHost.stop).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(droppedEventCount(sink)).toBe(1);
  });

  it("catches unrecoverable worker flush errors and disables the sink once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>();
    const workerHost = makeFailingWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const onWorkerUnavailable = vi.fn();
    const sink = new WorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost,
      onWorkerUnavailable,
    });

    sink.addRrwebEvent(makeEvent(10, "bad"));
    await expect(sink.flush("manual")).resolves.toBeUndefined();
    sink.addRrwebEvent(makeEvent(11, "ignored"));
    await sink.flush("manual");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(workerHost.stop).toHaveBeenCalledTimes(1);
    expect(onWorkerUnavailable).toHaveBeenCalledOnce();
    expect(droppedEventCount(sink)).toBe(1);
  });
});

describe("WorkerSink async visibility flushes", () => {
  it("does not take the destructive sync pagehide path while a flush is in flight", async () => {
    const sendBeacon = installSendBeacon(() => true);
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    const pendingWorker = makePendingWorkerHost();
    const session = makeSession(["session-one", "tab-one"]);
    const sink = new WorkerSink({
      config,
      session,
      window,
      fetch: fetchMock,
      workerHost: pendingWorker.workerHost,
    });

    sink.addRrwebEvent(makeEvent(10, "visible"));
    const firstFlush = sink.flush("manual");
    const secondFlush = sink.flush("visibility");

    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingWorker.workerHost.reset).not.toHaveBeenCalled();

    pendingWorker.resolve({
      payload: new TextEncoder().encode(JSON.stringify([makeEvent(10, "visible")])),
      uncompressed: true,
    });
    await firstFlush;
    await secondFlush;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(false);
  });
});
