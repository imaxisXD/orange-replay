// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { decodeIngestBody } from "@orange-replay/shared/wire";

const rrwebMocks = vi.hoisted(() => ({
  record: vi.fn(() => vi.fn()),
  addCustomEvent: vi.fn(),
  estimateEventBytes: vi.fn(() => 512),
}));

vi.mock("@orange-replay/rrweb-fork", () => rrwebMocks);

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  document.cookie = "or_s=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  window.history.replaceState(null, "", "/");
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
    const { buildLoaderScriptTag, buildLoaderSnippet } = await import("../src/loader.ts");
    const snippet = buildLoaderSnippet({
      bundleUrl: "https://cdn.test/orange-replay.iife.js",
      queueLimit: 1,
      init: {
        key: "write-key",
        ingestUrl: "https://ingest.test",
        blockSelector: ".secret-panel",
      },
    });

    expect(snippet).toContain('"key":"write-key"');
    expect(snippet).toContain('"blockSelector":".secret-panel"');
    expect(snippet).toContain("queueLimit:1");
    expect(snippet).toContain("q.length>=l");
    expect(snippet).toContain("u:w.location.href");
    expect(snippet).not.toContain("target:e.target");

    const scriptTag = buildLoaderScriptTag({
      bundleUrl: "https://cdn.test/orange-replay.iife.js",
      init: { key: "write-key", ingestUrl: "https://ingest.test" },
    });
    expect(scriptTag).toMatch(/^<script>\n/);
    expect(scriptTag).toMatch(/\n<\/script>$/);
  });

  it("escapes config values for inline script tags", async () => {
    const { buildLoaderScriptTag } = await import("../src/loader.ts");
    const scriptTag = buildLoaderScriptTag({
      bundleUrl: "https://cdn.test/sdk.js?</script><script>alert(1)</script>",
      init: {
        key: "or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ingestUrl: "https://ingest.test/\u2028\u2029",
        blockSelector: "[data-x='a&b>c']",
      },
    });

    const innerScript = scriptTag.slice("<script>\n".length, -"\n</script>".length);
    expect(innerScript).not.toContain("</script><script>");
    expect(innerScript).not.toContain("\u2028");
    expect(innerScript).not.toContain("\u2029");
    expect(innerScript).toContain("\\u003c/script\\u003e");
    expect(innerScript).toContain("\\u0026");
    expect(innerScript).toContain("\\u003e");
  });

  it("keeps dollar patterns literal in generated snippets", async () => {
    const { buildLoaderSnippet } = await import("../src/loader.ts");
    const snippet = buildLoaderSnippet({
      bundleUrl: "https://cdn.test/$'-$&.js",
      init: {
        key: "or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ingestUrl: "https://ingest.test/$&",
        blockSelector: '[data-test="$\'"]',
      },
    });

    expect(snippet).toContain('"https://cdn.test/$\'-$\\u0026.js"');
    expect(snippet).toContain('"ingestUrl":"https://ingest.test/$\\u0026"');
    expect(snippet).toContain('"blockSelector":"[data-test=\\"$\'\\"]"');
    expect(snippet).not.toContain("__BUNDLE_URL__");
    expect(snippet).not.toContain("__INIT_CONFIG__");
  });

  it("does not rescan substituted bundle URLs for placeholders", async () => {
    const { buildLoaderSnippet } = await import("../src/loader.ts");
    const snippet = buildLoaderSnippet({
      bundleUrl: "https://cdn.test/__INIT_CONFIG__/sdk.js",
      init: {
        key: "or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ingestUrl: "https://ingest.test",
      },
    });

    expect(snippet).toContain('"https://cdn.test/__INIT_CONFIG__/sdk.js"');
    expect(snippet).toContain('init:{"key":"or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
  });

  it("drains pre-buffered events into the first SDK batch", async () => {
    const bodies: Uint8Array[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/config")) {
        return new Response(
          JSON.stringify({
            sampleRate: 1,
            maskPolicyVersion: 1,
            maskRules: [],
            capture: { heatmaps: false, console: false, network: false, canvas: false },
            version: 1,
          }),
        );
      }
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
      transport: "inline",
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
    expect(
      decoded.index.e.find((event) => event.k === "vital" && event.d === "navigation")?.m?.["url"],
    ).toBe("/");
  });

  it("discards buffered events when a local privacy selector is unsafe", async () => {
    const ingestBodies: Uint8Array[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/config")) {
        return new Response(
          JSON.stringify({
            sampleRate: 1,
            maskPolicyVersion: 1,
            maskRules: [],
            capture: { heatmaps: false, console: false, network: false, canvas: false },
            version: 1,
          }),
        );
      }
      ingestBodies.push(init?.body as Uint8Array);
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    rrwebMocks.record.mockClear();

    const { installLoaderRuntime } = await import("../src/loader-runtime.ts");
    installLoaderRuntime({ bundleUrl: "https://cdn.test/sdk.js" });
    document.body.appendChild(document.createElement("button")).click();
    expect((window as Window & { __orq?: unknown[] }).__orq?.length).toBeGreaterThan(0);

    const { init } = await import("../src/index.ts");
    const handle = init({
      key: "write-key",
      ingestUrl: "https://ingest.test",
      sampleRate: 1,
      flushMs: 60_000,
      transport: "inline",
      blockSelector: ".private:hover",
    });
    await handle.stop();

    expect(rrwebMocks.record).not.toHaveBeenCalled();
    expect(ingestBodies).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "Orange Replay start failed.",
      expect.objectContaining({ message: "blockSelector must use a stable CSS selector." }),
    );
  });

  it("does not let an old failed handle clear a newer recorder", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/config")) {
        return new Response(
          JSON.stringify({
            sampleRate: 1,
            maskPolicyVersion: 1,
            maskRules: [],
            capture: { heatmaps: false, console: false, network: false, canvas: false },
            version: 1,
          }),
        );
      }
      return new Response(JSON.stringify({ ok: true, live: false, flushMs: 15_000 }));
    });
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });
    const { init } = await import("../src/index.ts");
    const options = { key: "write-key", ingestUrl: "https://ingest.test", sampleRate: 1 } as const;
    const oldHandle = init({ ...options, transport: "worker" });
    let newHandle = oldHandle;
    for (let attempt = 0; attempt < 50 && newHandle === oldHandle; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      newHandle = init({ ...options, transport: "inline" });
    }
    expect(newHandle).not.toBe(oldHandle);

    await oldHandle.stop();
    expect(init({ ...options, transport: "inline" })).toBe(newHandle);
    await newHandle.stop();
  });
});
