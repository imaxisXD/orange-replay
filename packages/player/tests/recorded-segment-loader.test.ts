import { describe, expect, it, vi } from "vite-plus/test";
import { buildSegment } from "@orange-replay/shared/wire";
import type { SessionManifest } from "@orange-replay/shared/types";
import {
  activeReplayWindowLimit,
  RecordedSegmentLoader,
} from "../src/player/recorded-segment-loader.ts";
import type { DecodeWorkerHost } from "../src/worker-host.ts";

describe("recorded segment loader limits", () => {
  it("enforces aggregate event and decoded-byte limits", () => {
    expect(
      activeReplayWindowLimit(
        { events: 80, decodedBytes: 20 },
        { events: 21, decodedBytes: 1 },
        { events: 100, decodedBytes: 100 },
      ),
    ).toBe("events");
    expect(
      activeReplayWindowLimit(
        { events: 80, decodedBytes: 90 },
        { events: 20, decodedBytes: 11 },
        { events: 100, decodedBytes: 100 },
      ),
    ).toBe("decodedBytes");
    expect(
      activeReplayWindowLimit(
        { events: 80, decodedBytes: 90 },
        { events: 20, decodedBytes: 10 },
        { events: 100, decodedBytes: 100 },
      ),
    ).toBeNull();
  });

  it("aborts and ignores stale segment work when the playback window changes", async () => {
    let requestSignal: AbortSignal | undefined;
    const onSegmentLoaded = vi.fn();
    const loader = new RecordedSegmentLoader({
      request: {
        api: {
          fetch: async (_input, init) => {
            requestSignal = init?.signal ?? undefined;
            return await new Promise<Response>((_resolve, reject) => {
              requestSignal?.addEventListener("abort", () => reject(new Error("request aborted")), {
                once: true,
              });
            });
          },
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker: {} as DecodeWorkerHost,
      isDestroyed: () => false,
      isFollowing: () => false,
      onSegmentLoaded,
    });
    loader.useManifest(manifest());

    const pendingLoad = loader.loadSegment(0);
    await waitFor(() => requestSignal !== undefined);
    loader.resetLoadedWindow(0);
    await pendingLoad;

    expect(requestSignal?.aborted).toBe(true);
    expect(onSegmentLoaded).not.toHaveBeenCalled();
  });

  it("does not start later old-window loads after a checkpoint reset", async () => {
    let firstRequestSignal: AbortSignal | undefined;
    let requestCount = 0;
    const onSegmentLoaded = vi.fn();
    const loader = new RecordedSegmentLoader({
      request: {
        api: {
          fetch: async (_input, init) => {
            requestCount += 1;
            firstRequestSignal ??= init?.signal ?? undefined;
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
                once: true,
              });
            });
          },
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker: {} as DecodeWorkerHost,
      isDestroyed: () => false,
      isFollowing: () => false,
      onSegmentLoaded,
    });
    loader.useManifest(manifest(3));

    const oldWindowLoad = loader.loadSegmentsInOrder([0, 1]);
    await waitFor(() => requestCount === 1);
    loader.resetLoadedWindow(2);
    await oldWindowLoad;
    await loader.loadSegment(1);

    expect(firstRequestSignal?.aborted).toBe(true);
    expect(requestCount).toBe(1);
    expect(onSegmentLoaded).not.toHaveBeenCalled();
    expect(loader.hasLoaded(0)).toBe(false);
    expect(loader.hasLoaded(1)).toBe(false);
  });

  it("stops an older far-seek plan when a near seek uses the same checkpoint", async () => {
    const segmentBytes = buildSegment([new TextEncoder().encode("[]")]);
    let resolveRequest = (_response: Response): void => undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    });
    let requestCount = 0;
    const onSegmentLoaded = vi.fn();
    const worker = {
      decodeBatchWithStats: vi.fn(async () => ({ decodedBytes: 2, events: [] })),
    } as unknown as DecodeWorkerHost;
    const loader = new RecordedSegmentLoader({
      request: {
        api: {
          fetch: async () => {
            requestCount += 1;
            return await pendingResponse;
          },
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker,
      isDestroyed: () => false,
      isFollowing: () => false,
      onSegmentLoaded,
    });
    loader.useManifest(manifest(3, segmentBytes.byteLength));

    const farSeek = loader.loadSegmentsInOrder([0, 1, 2]);
    await waitFor(() => requestCount === 1);
    const nearSeek = loader.loadSegmentsInOrder([0]);
    resolveRequest(new Response(segmentBytes as unknown as BodyInit));
    await Promise.all([farSeek, nearSeek]);

    expect(requestCount).toBe(1);
    expect(onSegmentLoaded).toHaveBeenCalledTimes(1);
    expect(onSegmentLoaded).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));
  });
});

function manifest(segmentCount = 1, segmentBytes = 3): SessionManifest {
  const segments = Array.from({ length: segmentCount }, (_unused, index) => ({
    key: `p/project/session/seg-${String(index + 1).padStart(6, "0")}.ors`,
    bytes: segmentBytes,
    t0: 1_000 + index * 1_000,
    t1: 2_000 + index * 1_000,
    batches: 1,
  }));
  return {
    v: 1,
    sessionId: "session",
    projectId: "project",
    orgId: "org",
    startedAt: 1_000,
    endedAt: 1_000 + segmentCount * 1_000,
    durationMs: segmentCount * 1_000,
    segments,
    timeline: [],
    counts: { batches: segmentCount, events: 0, clicks: 0, errors: 0, rages: 0, navs: 0 },
    bytes: segmentCount * segmentBytes,
    flags: 0,
    attrs: {},
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not pass in time");
}
