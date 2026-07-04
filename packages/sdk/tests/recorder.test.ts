// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { eventWithTime, recordOptions } from "@orange-replay/rrweb-fork";
import type { Sink } from "../src/sink.ts";
import type { RecorderConfig } from "../src/types.ts";

const rrwebMocks = vi.hoisted(() => ({
  record: vi.fn(),
  addCustomEvent: vi.fn(),
  takeFullSnapshot: vi.fn(),
}));

vi.mock("@orange-replay/rrweb-fork", () => rrwebMocks);

const baseConfig: RecorderConfig = {
  key: "key",
  ingestUrl: "https://ingest.test",
  projectRef: "key",
  sampleRate: 1,
  blockSelector: ".user-block",
  ignoreSelector: ".user-ignore",
  maskTextSelector: ".mask-text",
  allowUrlParams: [],
  flushMs: 15_000,
};

function makeSink(): Sink {
  return {
    addRrwebEvent() {
      /* test hook */
    },
    addIndexEvent() {
      /* test hook */
    },
    onNavigation() {
      /* test hook */
    },
    async flush() {
      /* test hook */
    },
    async prepareForSessionRotation() {
      /* test hook */
    },
    resetAfterSessionRotation() {
      /* test hook */
    },
    async stop() {
      /* test hook */
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  rrwebMocks.record.mockReset();
  rrwebMocks.addCustomEvent.mockReset();
  rrwebMocks.takeFullSnapshot.mockReset();
});

describe("Recorder", () => {
  it("passes privacy defaults into rrweb record", async () => {
    const stop = vi.fn();
    rrwebMocks.record.mockReturnValue(stop);
    const { Recorder } = await import("../src/recorder.ts");

    const recorder = new Recorder({ config: baseConfig, sink: makeSink() });
    recorder.start();

    const options = rrwebMocks.record.mock.calls[0]?.[0] as recordOptions<eventWithTime>;
    expect(options.maskAllInputs).toBe(true);
    expect(options.blockSelector).toBe("[data-orange-block], .user-block");
    expect(options.ignoreSelector).toBe("[data-orange-ignore], .user-ignore");
    expect(options.maskTextSelector).toBe(".mask-text");
    expect(options.checkoutEveryNms).toBe(240_000);
  });

  it("disables recording when the emit path fails and does not throw to the host page", async () => {
    const stop = vi.fn();
    let emit: ((event: eventWithTime) => void) | undefined;
    rrwebMocks.record.mockImplementation((options: recordOptions<eventWithTime>) => {
      emit = options.emit;
      return stop;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = makeSink();
    sink.addRrwebEvent = () => {
      throw new Error("sink failed");
    };
    const { Recorder } = await import("../src/recorder.ts");

    const recorder = new Recorder({ config: baseConfig, sink });
    recorder.start();

    expect(() =>
      emit?.({
        type: 0,
        timestamp: 1,
        data: {},
      } as eventWithTime),
    ).not.toThrow();

    expect(recorder.isDisabled()).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("asks rrweb for a checkout full snapshot during session rotation", async () => {
    const stop = vi.fn();
    rrwebMocks.record.mockReturnValue(stop);
    const { Recorder } = await import("../src/recorder.ts");

    const recorder = new Recorder({ config: baseConfig, sink: makeSink() });
    recorder.start();
    recorder.takeFullSnapshot();

    expect(rrwebMocks.takeFullSnapshot).toHaveBeenCalledWith(true);
  });
});
