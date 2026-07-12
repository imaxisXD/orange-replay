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
  maskPolicyVersion: 0,
  capture: { heatmaps: false, console: false, network: false, canvas: false },
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
    async prepareForSnapshotPart() {
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

    const sink = makeSink();
    const prepareForSnapshotPart = vi.spyOn(sink, "prepareForSnapshotPart");
    const recorder = new Recorder({ config: baseConfig, sink });
    recorder.start();

    const options = rrwebMocks.record.mock.calls[0]?.[0] as recordOptions<eventWithTime>;
    expect(options.maskAllInputs).toBe(true);
    expect(options.blockSelector).toBe("[data-orange-block], .user-block");
    expect(options.ignoreSelector).toBe("[data-orange-ignore], .user-ignore");
    expect(options.maskTextSelector).toBe(".mask-text");
    expect(options.inlineImages).toBe(true);
    expect(options.recordCanvas).toBe(false);
    expect(options.checkoutEveryNth).toBe(5_000);
    expect(options.checkoutEveryNms).toBe(240_000);
    expect(options.snapshotTimeSliceMs).toBe(4);
    await options.prepareForSnapshotPart?.(256_000);
    expect(prepareForSnapshotPart).toHaveBeenCalledWith(256_000);
  });

  it.each([
    ["invalid syntax", { blockSelector: "[" }],
    ["stateful block selector", { blockSelector: ".private:focus-within" }],
    ["stateful mask selector", { maskTextSelector: "input:checked" }],
  ])("disables recording for an unsafe local %s", async (_caseName, configOverride) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { Recorder } = await import("../src/recorder.ts");
    const recorder = new Recorder({
      config: { ...baseConfig, ...configOverride },
      sink: makeSink(),
    });

    expect(() => recorder.start()).toThrow("must use a stable CSS selector");
    expect(rrwebMocks.record).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("records with stable local privacy selectors", async () => {
    rrwebMocks.record.mockReturnValue(vi.fn());
    const { Recorder } = await import("../src/recorder.ts");
    const blockSelector =
      '[data-url="https://example.test/a:b"], .field\\:name, section > .private:nth-child(2)';
    const maskTextSelector = "article:not(.public)";
    const recorder = new Recorder({
      config: { ...baseConfig, blockSelector, maskTextSelector },
      sink: makeSink(),
    });

    recorder.start();

    const options = rrwebMocks.record.mock.calls[0]?.[0] as recordOptions<eventWithTime>;
    expect(options.blockSelector).toBe(`[data-orange-block], ${blockSelector}`);
    expect(options.maskTextSelector).toBe(maskTextSelector);
  });

  it("caps custom event names before they reach rrweb", async () => {
    rrwebMocks.record.mockReturnValue(vi.fn());
    const { Recorder } = await import("../src/recorder.ts");
    const recorder = new Recorder({ config: baseConfig, sink: makeSink() });
    recorder.start();

    recorder.addCustomEvent("x".repeat(500), { step: 1 });

    expect(rrwebMocks.addCustomEvent.mock.calls[0]?.[0]).toHaveLength(200);
  });

  it("records safe image frames when canvas capture is enabled", async () => {
    rrwebMocks.record.mockReturnValue(vi.fn());
    const { Recorder } = await import("../src/recorder.ts");
    const recorder = new Recorder({
      config: {
        ...baseConfig,
        capture: { ...baseConfig.capture, canvas: true },
      },
      sink: makeSink(),
    });

    recorder.start();

    const options = rrwebMocks.record.mock.calls[0]?.[0] as recordOptions<eventWithTime>;
    expect(options.recordCanvas).toBe(true);
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

describe("scrubMetaHref", () => {
  it("scrubs query strings and fragments from rrweb Meta events", async () => {
    const { scrubMetaHref } = await import("../src/recorder.ts");
    const meta = {
      type: 4,
      data: {
        href: "https://app.example.com/reset?token=abc123&keep=1#otp=999",
        width: 1,
        height: 1,
      },
      timestamp: 1,
    } as never;
    const scrubbed = scrubMetaHref(meta, ["keep"]) as { data: { href: string; width: number } };
    expect(scrubbed.data.href).not.toContain("token=abc123");
    expect(scrubbed.data.href).not.toContain("otp");
    expect(scrubbed.data.href).toContain("keep=1");
    expect(scrubbed.data.width).toBe(1);
  });

  it("passes non-meta events through untouched", async () => {
    const { scrubMetaHref } = await import("../src/recorder.ts");
    const incremental = { type: 3, data: { source: 1 }, timestamp: 2 } as never;
    expect(scrubMetaHref(incremental, [])).toBe(incremental);
  });
});
