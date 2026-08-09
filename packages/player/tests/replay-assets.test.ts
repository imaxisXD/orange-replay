// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ReplayAssetStore } from "../src/replay-assets.ts";
import type { PlayerApi } from "../src/types.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replay asset store", () => {
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
