import { describe, expect, it, vi } from "vite-plus/test";
import { buildSegment, encodeIngestBody } from "@orange-replay/shared/wire";
import type { SessionManifest } from "@orange-replay/shared/types";
import {
  activeReplayWindowLimit,
  RecordedSegmentLoader,
} from "../src/player/recorded-segment-loader.ts";
import type { DecodeWorkerHost } from "../src/worker-host.ts";
import { decodeBatchWithStats } from "../src/worker-core.ts";
import { ReplayEventStore } from "../src/player/replay-event-store.ts";
import type { ReplayEvent } from "../src/types.ts";

describe("recorded segment loader limits", () => {
  it("discards a tab decode that completes after selecting another tab", async () => {
    const { loader, worker, onSegmentLoaded } = multiTabLoader();
    const held = pendingValue<void>();
    worker.decodeBatchWithStats.mockImplementationOnce(async (payload) => {
      await held.promise;
      return decodeBatchWithStats(payload);
    });
    const first = loader.loadSegment(0);
    await vi.waitFor(() => expect(worker.decodeBatchWithStats).toHaveBeenCalledOnce());
    loader.selectTab("tab-background");
    held.resolve();
    await first;
    expect(onSegmentLoaded).not.toHaveBeenCalled();
    await loader.loadSegment(0);
    expect(onSegmentLoaded).toHaveBeenCalledOnce();
    expect(onSegmentLoaded.mock.calls[0]?.[0].batches[0]?.index?.tab).toBe("tab-background");
    expect(worker.decodeBatchWithStats).toHaveBeenCalledTimes(2);
    expect(loader.replayTab).toBe("tab-background");
  });
  it("releases a canceled fetched segment without waiting for its replay assets", async () => {
    const replayAssets = pendingValue<void>();
    const segmentBytes = buildSegment([new TextEncoder().encode("[]")]);
    const fetched = pendingValue<void>();
    const onSegmentLoaded = vi.fn();
    const worker = {
      decodeBatchWithStats: vi.fn(async () => ({ decodedBytes: 2, events: [] })),
    };
    const loader = new RecordedSegmentLoader({
      request: {
        api: {
          fetch: async () => {
            fetched.resolve();
            return new Response(segmentBytes as unknown as BodyInit);
          },
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker: worker as unknown as DecodeWorkerHost,
      replayAssetsReady: replayAssets.promise,
      isDestroyed: () => false,
      isFollowing: () => false,
      onSegmentLoaded,
    });
    loader.useManifest(manifest(1, segmentBytes.byteLength));

    const oldLoad = loader.loadSegment(0);
    await fetched.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.decodeBatchWithStats).not.toHaveBeenCalled();
    loader.resetLoadedWindow(0);
    await oldLoad;
    expect(onSegmentLoaded).not.toHaveBeenCalled();

    const newLoad = loader.loadSegment(0);
    replayAssets.resolve();
    await newLoad;
    expect(worker.decodeBatchWithStats).toHaveBeenCalledOnce();
    expect(onSegmentLoaded).toHaveBeenCalledOnce();
  });

  it("loads the selected tab without decoding background tabs or rejecting their checkpoints", async () => {
    const { loader, worker, onSegmentLoaded, selectedEvents } = multiTabLoader();

    await loader.loadSegment(0);

    expect(worker.decodeBatchWithStats).toHaveBeenCalledTimes(1);
    expect(onSegmentLoaded).toHaveBeenCalledOnce();
    expect(onSegmentLoaded.mock.calls[0]?.[0].batches).toEqual([
      expect.objectContaining({
        events: selectedEvents,
        index: expect.objectContaining({ tab: "tab-selected" }),
        segmentBatchIndex: 1,
      }),
    ]);
    expect(loader.hasLoaded(0)).toBe(true);
  });

  it("still rejects a selected-tab checkpoint that is absent from its decoded snapshot", async () => {
    const { loader, onSegmentLoaded } = multiTabLoader(1_050);

    await expect(loader.loadSegment(0)).rejects.toThrow("checkpoint metadata does not match");

    expect(onSegmentLoaded).not.toHaveBeenCalled();
    expect(loader.hasLoaded(0)).toBe(false);
  });

  it("keeps legacy tab selection through the next segment when snapshot times overlap", async () => {
    const firstSnapshot = {
      type: 2,
      timestamp: 1_500,
      data: {
        node: { id: 1, type: 0, childNodes: [] },
        initialOffset: { left: 0, top: 0 },
      },
    } as ReplayEvent;
    const start = { type: 1, timestamp: 1_000, data: {} } as ReplayEvent;
    const continuation = { type: 1, timestamp: 2_000, data: {} } as ReplayEvent;
    const indexedBatch = (tab: string, events: ReplayEvent[], sequence: number) =>
      encodeIngestBody(
        {
          v: 1,
          s: "session",
          tab,
          seq: sequence,
          t0: events[0]!.timestamp,
          t1: events.at(-1)!.timestamp,
          e: [],
        },
        new TextEncoder().encode(JSON.stringify(events)),
      );
    const segments = [
      buildSegment([
        indexedBatch("tab-first-batch", [start, firstSnapshot], 0),
        indexedBatch("tab-first-snapshot", [{ ...firstSnapshot, timestamp: 1_100 }], 0),
      ]),
      buildSegment([
        indexedBatch("tab-first-batch", [continuation], 1),
        indexedBatch("tab-first-snapshot", [{ ...continuation, timestamp: 2_100 }], 1),
      ]),
    ];
    const session = manifest(2);
    session.segments.forEach((segment, index) => {
      segment.bytes = segments[index]!.byteLength;
      segment.batches = 2;
    });
    const eventStore = new ReplayEventStore();
    const selectedEvents: ReplayEvent[] = [];
    const worker = { decodeBatchWithStats: vi.fn(decodeBatchWithStats) };
    let requestedSegment = 0;
    const loader = new RecordedSegmentLoader({
      request: {
        api: {
          fetch: async () => new Response(segments[requestedSegment++] as unknown as BodyInit),
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker: worker as unknown as DecodeWorkerHost,
      isDestroyed: () => false,
      isFollowing: () => false,
      onSegmentLoaded: ({ batches }) => {
        selectedEvents.push(...eventStore.eventsForRecordedBatches(batches));
      },
    });
    loader.useManifest(session);
    eventStore.resetRecordedEvents(loader.replayTab);

    await loader.loadSegmentsInOrder([0, 1]);

    expect(selectedEvents).toEqual([start, firstSnapshot, continuation]);
    expect(worker.decodeBatchWithStats).toHaveBeenCalledTimes(4);
  });

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

function multiTabLoader(selectedCheckpoint = 1_000) {
  const selectedEvents = [
    {
      type: 2,
      timestamp: 1_000,
      data: {
        node: { id: 1, type: 0, childNodes: [] },
        initialOffset: { left: 0, top: 0 },
      },
    },
  ];
  const backgroundEvents = [{ ...selectedEvents[0], timestamp: 1_100 }];
  const segmentBytes = buildSegment(
    [
      { tab: "tab-background", events: backgroundEvents, timestamp: 1_100 },
      { tab: "tab-selected", events: selectedEvents, timestamp: 1_000 },
    ].map(({ tab, events, timestamp }) =>
      encodeIngestBody(
        {
          v: 1,
          s: "session",
          tab,
          seq: 0,
          t0: timestamp,
          t1: timestamp,
          e: [],
          checkpointTimestamps: [timestamp],
        },
        new TextEncoder().encode(JSON.stringify(events)),
      ),
    ),
  );
  const session = manifest(1, segmentBytes.byteLength);
  session.segments[0]!.batches = 2;
  session.segments[0]!.checkpoints = [
    { timestamp: 1_100, tab: "tab-background", batch: 0 },
    { timestamp: selectedCheckpoint, tab: "tab-selected", batch: 1 },
  ];
  const worker = { decodeBatchWithStats: vi.fn(decodeBatchWithStats) };
  const onSegmentLoaded = vi.fn();
  const loader = new RecordedSegmentLoader({
    request: {
      api: { fetch: async () => new Response(segmentBytes as unknown as BodyInit) },
      projectId: "project",
      sessionId: "session",
    },
    signal: new AbortController().signal,
    worker: worker as unknown as DecodeWorkerHost,
    isDestroyed: () => false,
    isFollowing: () => false,
    onSegmentLoaded,
  });
  loader.useManifest(session);
  return { loader, worker, onSegmentLoaded, selectedEvents };
}

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

function pendingValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}
