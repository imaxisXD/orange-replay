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
  delete (
    window as Window & {
      __orq?: unknown[];
      __orCleanup?: Array<() => void>;
      __orInit?: unknown;
      __orLoaderStarted?: boolean;
    }
  ).__orq;
  delete (
    window as Window & {
      __orq?: unknown[];
      __orCleanup?: Array<() => void>;
      __orInit?: unknown;
      __orLoaderStarted?: boolean;
    }
  ).__orCleanup;
  delete (
    window as Window & {
      __orq?: unknown[];
      __orCleanup?: Array<() => void>;
      __orInit?: unknown;
      __orLoaderStarted?: boolean;
    }
  ).__orInit;
  delete (
    window as Window & {
      __orq?: unknown[];
      __orCleanup?: Array<() => void>;
      __orInit?: unknown;
      __orLoaderStarted?: boolean;
    }
  ).__orLoaderStarted;
});

describe("loader", () => {
  it("builds a bounded auto-init snippet without storing click targets", async () => {
    const { buildLoaderSnippet } = await import("../src/loader.ts");
    const snippet = buildLoaderSnippet({
      bundleUrl: "https://cdn.test/orange-replay.iife.js",
      init: {
        key: "write-key",
        ingestUrl: "https://ingest.test",
        blockSelector: ".secret-panel",
      },
    });

    expect(snippet).toContain('"key":"write-key"');
    expect(snippet).toContain('"blockSelector":".secret-panel"');
    expect(snippet).toContain("q.length>=l");
    expect(snippet).not.toContain("target:e.target");
  });

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
    const queuedClick = queued?.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && (item as { k?: unknown }).k === "click",
    );
    expect(queuedClick?.["d"]).toContain("button#early");
    expect(queuedClick?.["target"]).toBeUndefined();

    const { init } = await import("../src/index.ts");
    const handle = init({
      key: "write-key",
      ingestUrl: "https://ingest.test",
      sampleRate: 1,
      flushMs: 60_000,
    });
    await handle.stop();

    const sealedQueue = (window as Window & { __orq?: { push?: unknown } }).__orq;
    expect(Array.isArray(sealedQueue)).toBe(false);
    expect(typeof sealedQueue?.push).toBe("function");
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
