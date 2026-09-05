// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildSegment } from "@orange-replay/shared/wire";
import type { SessionManifest } from "@orange-replay/shared/types";
import { OrangePlayer } from "../src/player.ts";
import { ReplaySurface } from "../src/player/replay-surface.ts";
import { DecodeWorkerHost } from "../src/worker-host.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recorded replay asset readiness", () => {
  it("fetches the first segment during asset loading and applies its ready blob styling", async () => {
    const fixture = createAssetFixture();
    const decode = vi.spyOn(DecodeWorkerHost.prototype, "decodeBatchWithStats");
    const render = vi.spyOn(ReplaySurface.prototype, "rebuild").mockImplementation(() => undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ready-stylesheet");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      await fixture.player.ready();
      await vi.waitFor(() => expect(fixture.segmentRequests).toBe(1));
      fixture.releaseSegment();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(decode).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      expect(fixture.loadedSegments).toBe(0);

      const firstSeek = fixture.player.seek(0);
      const latestSeek = fixture.player.seek(200);
      fixture.releaseAsset();
      await Promise.all([firstSeek, latestSeek]);

      expect(fixture.segmentRequests).toBe(1);
      expect(fixture.loadedSegments).toBe(1);
      expect(decode).toHaveBeenCalledOnce();
      const renderedEvents = JSON.stringify(render.mock.calls[0]?.[0].events);
      expect(renderedEvents).toContain("blob:ready-stylesheet");
      expect(renderedEvents).not.toContain("https://recorded.test/site.css");
    } finally {
      fixture.player.destroy();
      fixture.container.remove();
    }
  });

  it("discards a fetched segment if the player is destroyed before assets are ready", async () => {
    const fixture = createAssetFixture();
    const decode = vi.spyOn(DecodeWorkerHost.prototype, "decodeBatchWithStats");
    const render = vi.spyOn(ReplaySurface.prototype, "rebuild").mockImplementation(() => undefined);
    const createUrl = vi.spyOn(URL, "createObjectURL");
    try {
      await fixture.player.ready();
      await vi.waitFor(() => expect(fixture.segmentRequests).toBe(1));
      fixture.releaseSegment();
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.player.destroy();
      fixture.releaseAsset();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(decode).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      expect(createUrl).not.toHaveBeenCalled();
      expect(fixture.loadedSegments).toBe(0);
    } finally {
      fixture.player.destroy();
      fixture.container.remove();
    }
  });
});

function createAssetFixture() {
  const css = "body{color:rgb(12,34,56)}";
  const assetHash = "a".repeat(64);
  const segment = buildSegment([
    new TextEncoder().encode(
      JSON.stringify([
        {
          type: 4,
          timestamp: 1_000,
          data: { href: "https://recorded.test/", width: 1280, height: 720 },
        },
        {
          type: 2,
          timestamp: 1_100,
          data: {
            node: {
              type: 0,
              id: 1,
              childNodes: [
                {
                  type: 2,
                  id: 2,
                  tagName: "link",
                  attributes: { rel: "stylesheet", href: "https://recorded.test/site.css" },
                  childNodes: [],
                },
              ],
            },
            initialOffset: { top: 0, left: 0 },
          },
        },
      ]),
    ),
  ]);
  const manifest: SessionManifest = {
    v: 1,
    sessionId: "session",
    projectId: "project",
    orgId: "org",
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    segments: [
      {
        key: "p/project/session/seg-000001.ors",
        bytes: segment.byteLength,
        t0: 1_000,
        t1: 2_000,
        batches: 1,
      },
    ],
    timeline: [],
    counts: { batches: 1, events: 2, clicks: 0, errors: 0, rages: 0, navs: 0 },
    bytes: segment.byteLength,
    flags: 0,
    attrs: {},
  };
  const assetResponse = pendingValue<Response>();
  const segmentResponse = pendingValue<Response>();
  const container = document.createElement("div");
  document.body.append(container);
  let segmentRequests = 0;
  let loadedSegments = 0;
  const player = new OrangePlayer(container, {
    api: {
      assetMapUrl: () => "/assets",
      assetUrl: () => "/stylesheet",
      fetch: async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/manifest")) return Response.json(manifest);
        if (url === "/assets") {
          return Response.json({
            version: 1,
            entries: [
              {
                sourceUrl: "https://recorded.test/site.css",
                parentHash: "",
                assetHash,
                contentType: "text/css",
                bytes: new TextEncoder().encode(css).byteLength,
                kind: "stylesheet",
              },
            ],
          });
        }
        if (url === "/stylesheet") return assetResponse.promise;
        segmentRequests += 1;
        return segmentResponse.promise;
      },
    },
    projectId: "project",
    sessionId: "session",
    worker: { allowSynchronousFallback: true },
  });
  player.on("segment", () => {
    loadedSegments += 1;
  });
  return {
    player,
    container,
    releaseAsset: () => assetResponse.resolve(new Response(css)),
    releaseSegment: () => segmentResponse.resolve(new Response(segment as unknown as BodyInit)),
    get segmentRequests() {
      return segmentRequests;
    },
    get loadedSegments() {
      return loadedSegments;
    },
  };
}

function pendingValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}
