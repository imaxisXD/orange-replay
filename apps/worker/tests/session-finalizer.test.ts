import type { FinalizeMessage, SessionManifest } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  createSessionFinalizeMetrics,
  SessionFinalizer,
  type SessionFinalizerDependencies,
} from "../src/do/session-finalizer.ts";
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
            seq: 2,
            t0: 2_000,
            t1: 2_000,
            url: "/a",
            events: [{ t: 2_000, k: "nav", d: "/a" }],
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
            seq: 0,
            t0: 0,
            t1: 0,
            url: "/a",
            events: [],
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
