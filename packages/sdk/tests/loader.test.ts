// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { decodeIngestBody } from "@orange-replay/shared/wire";

const rrwebMocks = vi.hoisted(() => ({
  record: vi.fn(() => vi.fn()),
  addCustomEvent: vi.fn(),
}));

vi.mock("@orange-replay/rrweb-fork", () => rrwebMocks);

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  document.cookie = "or_s=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  delete (window as Window & { __orq?: unknown[]; __orLoaderStarted?: boolean }).__orq;
  delete (window as Window & { __orq?: unknown[]; __orLoaderStarted?: boolean }).__orLoaderStarted;
});

describe("loader", () => {
  it("drains pre-buffered events into the first SDK batch", async () => {
    const bodies: Uint8Array[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    const { installLoaderRuntime } = await import("../src/loader-runtime.ts");
    installLoaderRuntime({ bundleUrl: "https://cdn.test/sdk.js" });

    const button = document.createElement("button");
    button.id = "early";
    document.body.appendChild(button);
    window.dispatchEvent(new ErrorEvent("error", { message: "early failure" }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 20 }));

    const queued = (window as Window & { __orq?: unknown[] }).__orq;
    expect(queued?.length).toBeGreaterThan(0);

    const { init } = await import("../src/index.ts");
    const handle = init({
      key: "write-key",
      ingestUrl: "https://ingest.test",
      sampleRate: 1,
      flushMs: 60_000,
    });
    await handle.stop();

    expect((window as Window & { __orq?: unknown[] }).__orq).toEqual([]);
    expect(bodies).toHaveLength(1);
    const decoded = decodeIngestBody(bodies[0] ?? new Uint8Array());
    expect(
      decoded.index.e.some((event) => event.k === "error" && event.d === "early failure"),
    ).toBe(true);
    expect(
      decoded.index.e.some(
        (event) => event.k === "click" && event.d?.includes("button#early") === true,
      ),
    ).toBe(true);
    expect(decoded.index.e.some((event) => event.k === "vital" && event.d === "navigation")).toBe(
      true,
    );
  });
});
