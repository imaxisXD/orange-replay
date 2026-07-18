import { describe, expect, it } from "vite-plus/test";
import { sessionLifecycle } from "../src/do/session-lifecycle.ts";
import { SessionLiveHub, type SessionLiveHubDependencies } from "../src/do/session-live-hub.ts";
import type { SessionState } from "../src/do/session-state.ts";

describe("live session ticket order", () => {
  it("rejects a replayed live ticket before building its snapshot", async () => {
    let snapshotBuilds = 0;
    const dependencies = {
      ctx: {
        getWebSockets: () => [],
      },
      getLifecycle: () => sessionLifecycle(activeState(), null),
      getSegmentRefs: () => [],
      getPendingBatchCount: () => 0,
      getPendingBatches: () => [],
      getLiveSnapshot: () => {
        snapshotBuilds += 1;
        return {};
      },
      requestCheckpointOnNextAppend: () => undefined,
      consumeLiveTicket: () => false,
    } as unknown as SessionLiveHubDependencies;
    const hub = new SessionLiveHub(dependencies);

    const response = await hub.fetch(
      new Request(
        "https://session.internal/api/v1/projects/project-held/sessions/session-held/live",
        {
          headers: {
            upgrade: "websocket",
            "x-or-live-auth": "ticket",
            "x-or-live-nonce": "00000000-0000-4000-8000-000000000001",
            "x-or-live-viewer": "a".repeat(64),
            "x-or-live-expires": String(Date.now() + 60_000),
          },
        },
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "ticket_used" });
    expect(snapshotBuilds).toBe(0);
  });
});

function activeState(): SessionState {
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
  };
}
