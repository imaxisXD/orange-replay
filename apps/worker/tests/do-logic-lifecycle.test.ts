import { describe, expect, it } from "vite-plus/test";
import { beginFinalizing, sessionIsClosed, sessionLifecycle } from "../src/do/session-lifecycle.ts";
import type { FinalizedTombstone } from "../src/do/session-recorder-store.ts";
import type { SessionState } from "../src/do/session-state.ts";

function openState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    projectId: "project_1",
    orgId: "org_1",
    shard: 0,
    retentionDays: 30,
    sessionId: "session_1",
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
    firstRequestId: "request_1",
    urlCount: 0,
    analyticsVersion: 2,
    pageCount: 0,
    quickBacks: 0,
    pageTabs: [],
    ...overrides,
  };
}

function tombstone(): FinalizedTombstone {
  return {
    finalized: true,
    finalizedAt: 8_000,
    purgeAt: 9_000,
    firstRequestId: "request_1",
    projectId: "project_1",
    orgId: "org_1",
    sessionId: "session_1",
  };
}

describe("session lifecycle", () => {
  it("answers open, finalizing, finalized, and empty from one predicate", () => {
    const cases = [
      { state: null, tombstone: null, status: "empty", closed: false },
      { state: openState(), tombstone: null, status: "open", closed: false },
      {
        state: openState({ finalizingAt: 1_300 }),
        tombstone: null,
        status: "finalizing",
        closed: true,
      },
      { state: null, tombstone: tombstone(), status: "finalized", closed: true },
      // The tombstone wins even if a stale in-memory state lingers.
      { state: openState(), tombstone: tombstone(), status: "finalized", closed: true },
      {
        state: openState({ finalizingAt: 1_300 }),
        tombstone: tombstone(),
        status: "finalized",
        closed: true,
      },
    ] as const;

    for (const testCase of cases) {
      const lifecycle = sessionLifecycle(testCase.state, testCase.tombstone);
      expect(
        lifecycle.status,
        `${String(testCase.state !== null)}/${String(testCase.tombstone !== null)}`,
      ).toBe(testCase.status);
      expect(sessionIsClosed(lifecycle)).toBe(testCase.closed);
    }
  });

  it("carries the finalizing timestamp and the tombstone through the lifecycle", () => {
    const finalizing = sessionLifecycle(openState({ finalizingAt: 1_300 }), null);
    expect(finalizing).toMatchObject({ status: "finalizing", finalizingAt: 1_300 });

    const finalized = sessionLifecycle(null, tombstone());
    expect(finalized).toMatchObject({ status: "finalized", tombstone: { purgeAt: 9_000 } });
  });

  it("begins finalizing exactly once and stays idempotent across retries", () => {
    const state = openState();
    const persisted: number[] = [];
    const persist = (updated: SessionState) => {
      persisted.push(updated.finalizingAt ?? -1);
    };

    const first = beginFinalizing(state, persist, () => 2_000);
    expect(first).toBe(2_000);
    expect(state.finalizingAt).toBe(2_000);
    expect(persisted).toEqual([2_000]);

    // A retry or recovery alarm must not move the timestamp or re-persist.
    const second = beginFinalizing(state, persist, () => 3_000);
    expect(second).toBe(2_000);
    expect(persisted).toEqual([2_000]);
    expect(sessionLifecycle(state, null).status).toBe("finalizing");
  });
});
