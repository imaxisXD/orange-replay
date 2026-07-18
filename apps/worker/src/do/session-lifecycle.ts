import type { FinalizedTombstone } from "./session-recorder-store.ts";
import type { SessionState } from "./session-state.ts";

/**
 * The one answer to "is this session closed".
 *
 * A session is closed the moment finalization begins (finalizingAt is
 * persisted, so late appends and live joins fail closed while manifest and
 * queue work are in flight) and stays closed once only the tombstone remains.
 * Every closed-decision — the append gates, alarm dispatch, live joins, and
 * the ack's closed flag — consumes this lifecycle instead of decoding
 * finalizingAt or the tombstone; only boot, debug output, and test seeding
 * read the raw pair.
 */
export type SessionLifecycle =
  | { status: "empty" }
  | { status: "open"; state: SessionState }
  | { status: "finalizing"; state: SessionState; finalizingAt: number }
  | { status: "finalized"; tombstone: FinalizedTombstone };

export function sessionLifecycle(
  state: SessionState | null,
  tombstone: FinalizedTombstone | null,
): SessionLifecycle {
  if (tombstone !== null) return { status: "finalized", tombstone };
  if (state === null) return { status: "empty" };
  if (state.finalizingAt !== undefined) {
    return { status: "finalizing", state, finalizingAt: state.finalizingAt };
  }
  return { status: "open", state };
}

/** The session state a lifecycle carries, when its status has one. */
export function lifecycleState(lifecycle: SessionLifecycle): SessionState | null {
  return lifecycle.status === "open" || lifecycle.status === "finalizing" ? lifecycle.state : null;
}

export function sessionIsClosed(
  lifecycle: SessionLifecycle,
): lifecycle is Extract<SessionLifecycle, { status: "finalizing" | "finalized" }> {
  return lifecycle.status === "finalizing" || lifecycle.status === "finalized";
}

/**
 * The one transition into "finalizing": persists finalizingAt exactly once
 * and returns it, so finalize retries and recovery alarms stay idempotent.
 */
export function beginFinalizing(
  state: SessionState,
  persist: (state: SessionState) => void,
  now: () => number = Date.now,
): number {
  if (state.finalizingAt === undefined) {
    state.finalizingAt = now();
    persist(state);
  }
  return state.finalizingAt;
}
