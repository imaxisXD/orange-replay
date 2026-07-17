import type { FinalizeMessage, SessionManifest } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  createSessionFinalizeMetrics,
  SessionFinalizer,
  type SessionFinalizerDependencies,
} from "../src/do/session-finalizer.ts";
import { MAX_FINALIZE_ANALYTICS_BATCHES, MAX_SESSION_BATCHES } from "../src/do/session-budgets.ts";
import { SessionLiveHub, type SessionLiveHubDependencies } from "../src/do/session-live-hub.ts";
import type { SessionState } from "../src/do/session-state.ts";

describe("session final handoff", () => {
  it("hands the immutable manifest to viewers before a held queue", async () => {
    const state = finalizingState();
    let releaseQueue = (): void => undefined;
    let queueStarted = false;
    let handoffCount = 0;
    let tombstoneWritten = false;
    let queuedMessage: FinalizeMessage | undefined;
    const heldQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    const dependencies = {
      recordings: {
        get: async () => null,
        put: async () => ({ etag: "manifest-written" }),
        head: async () => ({ etag: "sidecar-exists" }),
      },
      finalizeQueue: {
        send: async (message: FinalizeMessage) => {
          queuedMessage = message;
          queueStarted = true;
          await heldQueue;
        },
      },
      store: {
        finalPageBatches: () => [
          {
            tab: "tab-a",
            seq: 0,
            t0: 0,
            t1: 0,
            url: "/a",
            events: [],
            pageAnalyticsVersion: 1,
          },
          {
            tab: "tab-a",
            seq: 1,
            t0: 1_000,
            t1: 1_000,
            url: "/b",
            events: [{ t: 1_000, k: "nav", d: "/b" }],
            pageAnalyticsVersion: 1,
          },
          {
            tab: "tab-a",
            seq: 2,
            t0: 2_000,
            t1: 2_000,
            url: "/a",
            events: [{ t: 2_000, k: "nav", d: "/a" }],
            pageAnalyticsVersion: 1,
          },
        ],
        segmentRowsForManifest: () => [],
        storedEventRows: () => [],
        replaceStateWithTombstone: () => {
          tombstoneWritten = true;
        },
      },
      segmentWriter: {
        assertRecordingMatches: async () => undefined,
        assertRecordingStreamMatches: async () => undefined,
      },
      getSessionState: () => state,
      flushPendingBatches: async () => undefined,
      acceptedUsageReservationsEnabled: true,
      reserveAcceptedUsage: async () => undefined,
      markPresenceFinalizing: async () => undefined,
      finalizeViewers: (_manifest: SessionManifest) => {
        handoffCount += 1;
      },
      rememberTombstone: () => undefined,
      scheduleTombstonePurge: async () => undefined,
    } as unknown as SessionFinalizerDependencies;
    const finalizer = new SessionFinalizer(dependencies);

    const completion = finalizer.finalize(createSessionFinalizeMetrics());
    for (let tick = 0; tick < 10 && !queueStarted; tick += 1) {
      await Promise.resolve();
    }

    expect(queueStarted).toBe(true);
    expect(handoffCount).toBe(1);
    expect(tombstoneWritten).toBe(false);

    releaseQueue();
    await completion;
    expect(handoffCount).toBe(2);
    expect(tombstoneWritten).toBe(true);
    expect(queuedMessage?.attrs).toMatchObject({ entryUrl: "/a", urlCount: 3, pageCount: 3 });
    expect(queuedMessage?.insights?.quickBacks).toBe(1);
    expect(queuedMessage?.bytes).toBe(0);
  });

  it("reserves server-observed bytes without changing displayed replay bytes", async () => {
    const state = finalizingState();
    state.totalPayloadBytes = 900_000;
    state.totalEventBytes = 100_000;
    let queuedMessage: FinalizeMessage | undefined;
    let reservedBytes = 0;
    const dependencies = {
      recordings: {
        get: async () => null,
        put: async () => ({ etag: "written" }),
        head: async () => ({ etag: "sidecar-exists" }),
      },
      finalizeQueue: {
        send: async (message: FinalizeMessage) => {
          queuedMessage = message;
        },
      },
      store: {
        finalPageBatches: () => [],
        segmentRowsForManifest: () => [
          {
            key: "p/project-held/session-held/seg-000001.ors",
            bytes: 800_000,
            t0: 1_000,
            t1: 1_200,
            batches: 1,
            events: [],
          },
        ],
        storedEventRows: () => [],
        replaceStateWithTombstone: () => undefined,
      },
      segmentWriter: {
        assertRecordingMatches: async () => undefined,
        assertRecordingStreamMatches: async () => undefined,
      },
      getSessionState: () => state,
      flushPendingBatches: async () => undefined,
      acceptedUsageReservationsEnabled: true,
      reserveAcceptedUsage: async (_state: SessionState, bytes: number) => {
        reservedBytes = bytes;
      },
      markPresenceFinalizing: async () => undefined,
      finalizeViewers: () => undefined,
      rememberTombstone: () => undefined,
      scheduleTombstonePurge: async () => undefined,
    } as unknown as SessionFinalizerDependencies;

    await new SessionFinalizer(dependencies).finalize(createSessionFinalizeMetrics());

    expect(queuedMessage?.bytes).toBe(800_000);
    expect(reservedBytes).toBe(1_000_000);
  });

  it("keeps recorder reservations off during the first rollout stage", async () => {
    const state = finalizingState();
    let reservationCalls = 0;
    let queuedMessage: FinalizeMessage | undefined;
    const dependencies = {
      recordings: {
        get: async () => null,
        put: async () => ({ etag: "written" }),
        head: async () => ({ etag: "sidecar-exists" }),
      },
      finalizeQueue: {
        send: async (message: FinalizeMessage) => {
          queuedMessage = message;
        },
      },
      store: {
        finalPageBatches: () => [],
        segmentRowsForManifest: () => [],
        storedEventRows: () => [],
        replaceStateWithTombstone: () => undefined,
      },
      segmentWriter: {
        assertRecordingMatches: async () => undefined,
        assertRecordingStreamMatches: async () => undefined,
      },
      getSessionState: () => state,
      flushPendingBatches: async () => undefined,
      acceptedUsageReservationsEnabled: false,
      reserveAcceptedUsage: async () => {
        reservationCalls += 1;
      },
      markPresenceFinalizing: async () => undefined,
      finalizeViewers: () => undefined,
      rememberTombstone: () => undefined,
      scheduleTombstonePurge: async () => undefined,
    } as unknown as SessionFinalizerDependencies;

    await new SessionFinalizer(dependencies).finalize(createSessionFinalizeMetrics());

    expect(reservationCalls).toBe(0);
    expect(queuedMessage).toBeDefined();
    expect(Object.hasOwn(queuedMessage ?? {}, "usageBytes")).toBe(false);
  });

  it("reuses an immutable manifest written by an earlier deploy", async () => {
    const state = finalizingState();
    state.batchCount = MAX_SESSION_BATCHES;
    const existingManifest: SessionManifest = {
      v: 1,
      projectId: state.projectId,
      orgId: state.orgId,
      sessionId: state.sessionId,
      startedAt: 900,
      endedAt: 1_400,
      durationMs: 500,
      segments: [
        {
          key: "p/project-held/session-held/seg-000001.ors",
          bytes: 777,
          t0: 900,
          t1: 1_400,
          batches: 1,
          checkpoints: [{ timestamp: 950, tab: "tab-a", batch: 0 }],
        },
      ],
      timeline: [{ t: 1_000, k: "custom", d: "from-the-old-deploy" }],
      counts: { batches: 1, events: 1, clicks: 0, errors: 0, rages: 0, navs: 0 },
      bytes: 777,
      flags: 5,
      attrs: { country: "CA", entryUrl: "/old-deploy" },
    };
    let manifestWrites = 0;
    let reservedBytes = 0;
    let queuedMessage: FinalizeMessage | undefined;
    const dependencies = {
      recordings: {
        get: async () => ({ json: async () => existingManifest }),
        put: async () => {
          manifestWrites += 1;
          return { etag: "unexpected-write" };
        },
      },
      finalizeQueue: {
        send: async (message: FinalizeMessage) => {
          queuedMessage = message;
        },
      },
      store: {
        finalPageBatches: () => [],
        segmentRowsForManifest: () => ({
          [Symbol.iterator]() {
            throw new Error("an existing manifest must not be regenerated");
          },
        }),
        storedEventRows: () => [],
        replaceStateWithTombstone: () => undefined,
      },
      segmentWriter: {
        assertRecordingMatches: async () => undefined,
        assertRecordingStreamMatches: async () => undefined,
      },
      getSessionState: () => state,
      flushPendingBatches: async () => undefined,
      acceptedUsageReservationsEnabled: true,
      reserveAcceptedUsage: async (_state: SessionState, bytes: number) => {
        reservedBytes = bytes;
      },
      markPresenceFinalizing: async () => undefined,
      finalizeViewers: () => undefined,
      rememberTombstone: () => undefined,
      scheduleTombstonePurge: async () => undefined,
    } as unknown as SessionFinalizerDependencies;

    await new SessionFinalizer(dependencies).finalize(createSessionFinalizeMetrics());

    expect(manifestWrites).toBe(0);
    expect(reservedBytes).toBe(777);
    expect(queuedMessage).toMatchObject({
      durationMs: 500,
      hasCheckpoint: true,
      bytes: 777,
      segments: 1,
      flags: 5,
      counts: existingManifest.counts,
      attrs: existingManifest.attrs,
    });
  });

  it("bounds analytics work for the largest accepted session", async () => {
    const state = finalizingState();
    state.batchCount = MAX_SESSION_BATCHES;
    let finalPageReads = 0;
    let eventRowReads = 0;
    let queuedMessage: FinalizeMessage | undefined;
    const writtenKeys: string[] = [];
    const dependencies = {
      recordings: {
        get: async () => null,
        put: async (key: string) => {
          writtenKeys.push(key);
          return { etag: "written" };
        },
        head: async () => null,
      },
      finalizeQueue: {
        send: async (message: FinalizeMessage) => {
          queuedMessage = message;
        },
      },
      store: {
        finalPageBatches: () => ({
          [Symbol.iterator]() {
            finalPageReads += 1;
            throw new Error("overflow page analytics must use the stored bounded state");
          },
        }),
        segmentRowsForManifest: () => [],
        storedEventRows: () => ({
          *[Symbol.iterator]() {
            for (let index = 0; index < MAX_SESSION_BATCHES; index += 1) {
              eventRowReads += 1;
              yield { events: "[]" };
            }
          },
        }),
        replaceStateWithTombstone: () => undefined,
      },
      segmentWriter: {
        assertRecordingMatches: async () => undefined,
        assertRecordingStreamMatches: async () => undefined,
      },
      getSessionState: () => state,
      flushPendingBatches: async () => undefined,
      acceptedUsageReservationsEnabled: true,
      reserveAcceptedUsage: async () => undefined,
      markPresenceFinalizing: async () => undefined,
      finalizeViewers: () => undefined,
      rememberTombstone: () => undefined,
      scheduleTombstonePurge: async () => undefined,
    } as unknown as SessionFinalizerDependencies;

    await new SessionFinalizer(dependencies).finalize(createSessionFinalizeMetrics());

    expect(finalPageReads).toBe(0);
    expect(eventRowReads).toBe(MAX_FINALIZE_ANALYTICS_BATCHES);
    expect(queuedMessage?.analyticsVersion).toBe(0);
    expect(queuedMessage?.analyticsSidecarKey).toBeUndefined();
    expect(writtenKeys).toEqual([queuedMessage?.manifestKey]);
  });

  it("rejects a late live viewer after finalizing starts", async () => {
    const state = finalizingState();
    const dependencies = {
      ctx: {
        getWebSockets: () => [],
      },
      getSessionState: () => state,
      getSegmentRefs: () => [],
      getPendingBatchCount: () => 0,
      getPendingBatches: () => [],
      getLiveSnapshot: () => null,
      requestCheckpointOnNextAppend: () => undefined,
    } as unknown as SessionLiveHubDependencies;
    const hub = new SessionLiveHub(dependencies);

    const response = await hub.fetch(
      new Request(
        "https://session.internal/api/v1/projects/project-held/sessions/session-held/live",
        {
          headers: { upgrade: "websocket" },
        },
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "session_finalizing" });
  });
});

function finalizingState(): SessionState {
  return {
    projectId: "project-held",
    orgId: "org-held",
    shard: 0,
    retentionDays: 30,
    sessionId: "session-held",
    startedAt: 1_000,
    lastActivity: 1_200,
    lastFlushAt: 1_200,
    bufferedBytes: 0,
    totalPayloadBytes: 0,
    totalEventBytes: 0,
    batchCount: 0,
    segmentCount: 0,
    flags: 0,
    attrs: {},
    firstRequestId: "request-held",
    urlCount: 0,
    analyticsVersion: 2,
    pageCount: 0,
    quickBacks: 0,
    pageTabs: [],
    finalizingAt: 1_300,
  };
}
