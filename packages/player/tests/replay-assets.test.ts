// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ReplayAssetStore } from "../src/replay-assets.ts";
import type { PlayerApi } from "../src/types.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("replay asset store", () => {
  it("limits a stalled asset map to five seconds without aborting the player", async () => {
    vi.useFakeTimers();
    const playerAbort = new AbortController();
    const map = pendingValue<Response>();
    let assetSignal: AbortSignal | null | undefined;
    const store = new ReplayAssetStore(
      {
        assetMapUrl: () => "/assets",
        fetch: async (_input, init) => {
          assetSignal = init?.signal;
          return map.promise;
        },
      },
      { projectId: "project", sessionId: "session" },
      playerAbort.signal,
    );
    let finished = false;
    const loading = store.load().then(() => {
      finished = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
    await loading;
    expect(assetSignal?.aborted).toBe(true);
    expect(playerAbort.signal.aborted).toBe(false);
    map.resolve(Response.json({ version: 1, entries: [] }));
    store.destroy();
  });

  it("keeps completed assets at the deadline and ignores late bytes without starting queued requests", async () => {
    vi.useFakeTimers();
    const css = "body{color:green}";
    const entries = Array.from({ length: 8 }, (_unused, index) => ({
      sourceUrl: `https://recorded.test/${index}.css`,
      parentHash: "",
      assetHash: String(index).repeat(64),
      contentType: "text/css",
      bytes: new TextEncoder().encode(css).byteLength,
      kind: "stylesheet",
    }));
    const stalled: Array<ReturnType<typeof pendingValue<Response>>> = [];
    const signals: AbortSignal[] = [];
    let assetRequests = 0;
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:completed-style");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const store = new ReplayAssetStore(
      {
        assetMapUrl: () => "/assets",
        assetUrl: ({ assetHash }) => `/assets/${assetHash}`,
        fetch: async (input, init) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url === "/assets") return Response.json({ version: 1, entries });
          assetRequests += 1;
          if (init?.signal) signals.push(init.signal);
          if (url.endsWith("0".repeat(64))) return new Response(css);
          const response = pendingValue<Response>();
          stalled.push(response);
          return response.promise;
        },
      },
      { projectId: "project", sessionId: "session" },
      new AbortController().signal,
    );
    let finished = false;
    const loading = store.load().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(assetRequests).toBe(7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(finished).toBe(true);
    await loading;

    expect(store.rewriteUrl("https://recorded.test/0.css", "stylesheet")).toBe(
      "blob:completed-style",
    );
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(createUrl).toHaveBeenCalledOnce();
    for (const response of stalled) response.resolve(new Response(css));
    await vi.advanceTimersByTimeAsync(0);

    expect(assetRequests).toBe(7);
    expect(createUrl).toHaveBeenCalledOnce();
    expect(store.rewriteUrl("https://recorded.test/1.css", "stylesheet")).toBeUndefined();
    store.destroy();
    expect(revokeUrl).toHaveBeenCalledWith("blob:completed-style");
  });

  it("settles an unfinished load immediately when its store is destroyed", async () => {
    vi.useFakeTimers();
    const response = pendingValue<Response>();
    let assetSignal: AbortSignal | null | undefined;
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const store = new ReplayAssetStore(
      {
        assetMapUrl: () => "/assets",
        fetch: async (_input, init) => {
          assetSignal = init?.signal;
          return response.promise;
        },
      },
      { projectId: "project", sessionId: "session" },
      new AbortController().signal,
    );
    let finished = false;
    const loading = store.load().then(() => {
      finished = true;
    });
    store.destroy();
    await vi.advanceTimersByTimeAsync(0);

    expect(finished).toBe(true);
    await loading;
    expect(assetSignal?.aborted).toBe(true);
    response.resolve(Response.json({ version: 1, entries: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(createUrl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes captured CSS into blob URLs and revokes every object URL", async () => {
    const stylesheetHash = "a".repeat(64);
    const imageHash = "b".repeat(64);
    const css = 'body{background-image:url("/image.png")}';
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/assets")) {
        return Response.json({
          version: 1,
          entries: [
            {
              sourceUrl: "https://customer.test/site.css",
              parentHash: "",
              assetHash: stylesheetHash,
              contentType: "text/css",
              bytes: new TextEncoder().encode(css).byteLength,
              kind: "stylesheet",
            },
            {
              sourceUrl: "/image.png",
              parentHash: stylesheetHash,
              assetHash: imageHash,
              contentType: "image/png",
              bytes: image.byteLength,
              kind: "image",
            },
          ],
        });
      }
      if (url.endsWith(stylesheetHash)) return new Response(css);
      if (url.endsWith(imageHash)) return new Response(image);
      return new Response(null, { status: 404 });
    });
    const blobs: Blob[] = [];
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      if (!(blob instanceof Blob)) throw new Error("Expected a replay asset Blob.");
      blobs.push(blob);
      return `blob:replay-${blobs.length}`;
    });
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const api: PlayerApi = {
      fetch: fetchMock,
      assetMapUrl: () => "/assets",
      assetUrl: ({ assetHash }) => `/assets/${assetHash}`,
    };
    const controller = new AbortController();
    const store = new ReplayAssetStore(
      api,
      { projectId: "project", sessionId: "session" },
      controller.signal,
    );

    await store.load();

    expect(store.rewriteUrl("https://customer.test/site.css", "stylesheet")).toBe("blob:replay-2");
    expect(await blobs[1]?.text()).toContain("blob:replay-1");
    expect(await blobs[1]?.text()).not.toContain("/image.png");
    expect(createObjectUrl).toHaveBeenCalledTimes(2);

    store.destroy();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:replay-1");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:replay-2");
  });

  it("does not request assets unless the host explicitly enables the private routes", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const store = new ReplayAssetStore(
      { fetch: fetchMock },
      { projectId: "project", sessionId: "session" },
      new AbortController().signal,
    );

    await store.load();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function pendingValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}
