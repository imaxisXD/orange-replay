// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { IndexEvent } from "@orange-replay/shared/types";
import { markSdkInternalError } from "../src/internal-error.ts";
import { Sidecar } from "../src/sidecar.ts";
import type { Sink } from "../src/sink.ts";
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Sidecar internal error filtering", () => {
  it("does not record SDK-marked unhandled rejections", () => {
    const addIndexEvent = vi.fn<(event: IndexEvent) => void>();
    const sink = makeSink(addIndexEvent);
    const sidecar = new Sidecar({ config, sink, now: () => 1, window });
    sidecar.start();

    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", {
      value: markSdkInternalError(new Error("internal flush failed")),
    });
    window.dispatchEvent(event);
    sidecar.stop();

    expect(addIndexEvent).not.toHaveBeenCalled();
  });
});

function makeSink(addIndexEvent: (event: IndexEvent) => void): Sink {
  return {
    addRrwebEvent: vi.fn(),
    addIndexEvent,
    onNavigation: vi.fn(),
    flush: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}
