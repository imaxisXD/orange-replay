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
  maskPolicyVersion: 0,
  capture: { heatmaps: false, console: false, network: false, canvas: false },
  allowUrlParams: [],
  flushMs: 15_000,
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
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

    expect(addIndexEvent.mock.calls.map(([recorded]) => recorded.k)).not.toContain("error");
  });
});

describe("Sidecar privacy scrubbing", () => {
  it("adds one scrubbed page-load event when the SDK starts directly", () => {
    const addIndexEvent = vi.fn<(event: IndexEvent) => void>();
    const sink = makeSink(addIndexEvent);
    window.history.replaceState(null, "", "/orders?token=hidden#private");

    const sidecar = new Sidecar({ config, sink, now: () => 10, window });
    sidecar.start();
    sidecar.stop();

    expect(addIndexEvent).toHaveBeenCalledWith({
      t: 10,
      k: "vital",
      d: "navigation",
      m: { start: expect.any(Number), url: "/orders" },
    });
  });

  it("keeps one scrubbed page-load event from the loader queue", () => {
    const addIndexEvent = vi.fn<(event: IndexEvent) => void>();
    const sink = makeSink(addIndexEvent);
    (window as Window & { __orq?: unknown[] }).__orq = [
      {
        k: "vital",
        n: "navigation",
        t: 5,
        start: 1,
        u: "/checkout?token=hidden#private",
      },
    ];

    const sidecar = new Sidecar({ config, sink, now: () => 10, window });
    sidecar.start();
    sidecar.stop();

    expect(
      addIndexEvent.mock.calls.map(([event]) => event).filter((event) => event.d === "navigation"),
    ).toEqual([{ t: 5, k: "vital", d: "navigation", m: { start: 1, url: "/checkout" } }]);
  });

  it("redacts click details inside blocked subtrees", () => {
    const addIndexEvent = vi.fn<(event: IndexEvent) => void>();
    const sink = makeSink(addIndexEvent);
    const sidecar = new Sidecar({ config, sink, now: () => 10, window });
    document.body.innerHTML =
      '<div data-orange-block><button id="row-jane.doe@corp.com" class="patient-4482 diabetic">Save</button></div>';

    sidecar.start();
    document
      .querySelector("button")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100, clientY: 50 }));
    sidecar.stop();

    expect(addIndexEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        k: "click",
        d: "[blocked]",
        m: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      }),
    );
    expect(JSON.stringify(addIndexEvent.mock.calls)).not.toContain("jane");
    expect(JSON.stringify(addIndexEvent.mock.calls)).not.toContain("patient-4482");
  });

  it("redacts blocked click details when draining the loader pre-buffer", () => {
    const addIndexEvent = vi.fn<(event: IndexEvent) => void>();
    const sink = makeSink(addIndexEvent);
    document.body.innerHTML =
      '<section data-orange-block><button id="account-secret" class="private-row">Open</button></section>';
    const target = document.querySelector("button");
    (window as Window & { __orq?: unknown[] }).__orq = [
      { k: "click", t: 5, x: 20, y: 25, w: 200, h: 100, target },
    ];

    const sidecar = new Sidecar({ config, sink, now: () => 10, window });
    sidecar.start();
    sidecar.stop();

    expect(addIndexEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        t: 5,
        k: "click",
        d: "[blocked]",
        m: { x: 0.1, y: 0.25, w: 200, h: 100 },
      }),
    );
  });

  it("caps custom metadata keys, entry count, and total bytes", () => {
    const addIndexEvent = vi.fn<(event: IndexEvent) => void>();
    const sink = makeSink(addIndexEvent);
    const sidecar = new Sidecar({ config, sink, now: () => 1, window });
    const meta = Object.fromEntries(
      Array.from({ length: 40 }, (_value, index) => [
        `${"email-owner-".repeat(30)}${index}`,
        "x".repeat(500),
      ]),
    );

    const returnedMeta = sidecar.addCustomEvent("checkout", meta);

    const event = addIndexEvent.mock.calls[0]?.[0];
    const cleanMeta = event?.m ?? {};
    expect(Object.keys(cleanMeta).length).toBeGreaterThan(0);
    expect(Object.keys(cleanMeta).length).toBeLessThanOrEqual(20);
    expect(Object.keys(cleanMeta).every((key) => key.length <= 200)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(cleanMeta)).byteLength).toBeLessThanOrEqual(
      2 * 1024,
    );
    expect(returnedMeta).toEqual(cleanMeta);
  });

  it("removes secrets from URL-like custom metadata before sending", () => {
    const addIndexEvent = vi.fn<(event: IndexEvent) => void>();
    const sidecar = new Sidecar({ config, sink: makeSink(addIndexEvent), now: () => 1, window });
    const secret = "secret-token-123";

    const returnedMeta = sidecar.addCustomEvent("checkout", {
      referrer: `https://search.example/results?q=shoes&token=${secret}#result`,
      page_url: `/checkout?token=${secret}#payment`,
      redirectUri: `https://shop.example/complete?code=${secret}`,
      URL: `https://shop.example/orders?session=${secret}`,
      Href: `/orders/1?key=${secret}#receipt`,
      destination: `https://shop.example/account?access_token=${secret}`,
      label: "buy now",
    });

    expect(returnedMeta).toEqual({
      referrer: "/results",
      page_url: "/checkout",
      redirectUri: "/complete",
      URL: "/orders",
      Href: "/orders/1",
      destination: "/account",
      label: "buy now",
    });
    expect(JSON.stringify(addIndexEvent.mock.calls)).not.toContain(secret);
  });
});

function makeSink(addIndexEvent: (event: IndexEvent) => void): Sink {
  return {
    addRrwebEvent: vi.fn(),
    addIndexEvent,
    onNavigation: vi.fn(),
    flush: vi.fn(async () => undefined),
    prepareForSnapshotPart: vi.fn(async () => undefined),
    prepareForSessionRotation: vi.fn(async () => undefined),
    resetAfterSessionRotation: vi.fn(),
    stop: vi.fn(async () => undefined),
  };
}
