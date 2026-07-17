import type { IndexEvent, SegmentRef, SessionCounts, SessionManifest } from "@orange-replay/shared";
import {
  capTimelineEventsToBudget,
  MAX_MANIFEST_TIMELINE_BYTES,
  MAX_MANIFEST_TIMELINE_EVENTS,
} from "./session-budgets.ts";
import type { SessionState } from "./session-state.ts";

export interface SegmentForManifest extends SegmentRef {
  events: IndexEvent[];
}

// Recorded batch times are already clamped per batch against server time
// (session-budgets.ts), but the past window there is 24h so delayed retries
// stay storable. Duration is a product fact, so its start gets a much tighter
// bound: the first batch may buffer at most this long before the server
// learns the session exists.
export const FIRST_BATCH_LOOKBACK_CAP_MS = 5 * 60_000;

export function countTimelineEvents(segments: readonly SegmentForManifest[]): number {
  return segments.reduce((total, segment) => total + segment.events.length, 0);
}

/**
 * Server-observed session bounds (first batch arrival to last activity).
 * D1 ordering, retention, and expiry keep these; the manifest itself carries
 * recorded event time so playback and duration describe what was captured.
 */
export function sessionServerBounds(
  state: Pick<SessionState, "startedAt" | "lastActivity">,
  segments: readonly SegmentRef[],
): { startedAt: number; endedAt: number } {
  return {
    startedAt: state.startedAt,
    endedAt: Math.max(state.lastActivity, ...segments.map((segment) => segment.t1)),
  };
}

export function manifestHasCheckpoint(segments: readonly SegmentRef[]): boolean {
  return segments.some((segment) => (segment.checkpoints?.length ?? 0) > 0);
}

export function buildSessionManifest(
  state: SessionState,
  segments: readonly SegmentForManifest[],
  fullTimeline: readonly IndexEvent[] = segments.flatMap((segment) => segment.events),
  fullEventCounts?: Omit<SessionCounts, "batches">,
): SessionManifest {
  const timeline = capTimelineEventsToBudget(
    fullTimeline.toSorted((left, right) => left.t - right.t),
    MAX_MANIFEST_TIMELINE_EVENTS,
    MAX_MANIFEST_TIMELINE_BYTES,
  );
  // The manifest is the playback artifact, so its bounds are recorded event
  // time (segment t0/t1 from the client sidecar, clamped at append). A
  // single-batch session then reports its real captured span instead of the
  // zero-width gap between identical server arrival times. Recorded start is
  // bounded so a skewed client cannot stretch duration past the server span
  // plus one buffer window.
  const serverBounds = sessionServerBounds(state, segments);
  const startedAt =
    segments.length > 0
      ? Math.max(
          Math.min(...segments.map((segment) => segment.t0)),
          state.startedAt - FIRST_BATCH_LOOKBACK_CAP_MS,
        )
      : state.startedAt;
  const endedAt =
    segments.length > 0
      ? Math.max(startedAt, ...segments.map((segment) => segment.t1))
      : serverBounds.endedAt;
  const attrs: SessionManifest["attrs"] = { ...state.attrs };

  if (state.entryUrl !== undefined) {
    attrs.entryUrl = state.entryUrl;
  }
  if (state.urlCount > 0) {
    attrs.urlCount = state.urlCount;
  }
  if (state.analyticsVersion >= 1) {
    attrs.pageCount = state.pageCount;
  }

  const eventCounts = fullEventCounts ?? {
    events: fullTimeline.length,
    clicks: countEvents(fullTimeline, "click"),
    errors: countEvents(fullTimeline, "error"),
    rages: countEvents(fullTimeline, "rage"),
    navs: countEvents(fullTimeline, "nav"),
  };

  const manifest: SessionManifest = {
    v: 1,
    sessionId: state.sessionId,
    projectId: state.projectId,
    orgId: state.orgId,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    segments: segments.map(({ events: _events, ...segment }) => segment),
    timeline,
    counts: {
      batches: segments.reduce((total, segment) => total + segment.batches, 0),
      ...eventCounts,
    },
    bytes: segments.reduce((total, segment) => total + segment.bytes, 0),
    flags: state.flags,
    attrs,
  };

  if (state.encKeyId !== undefined) {
    manifest.enc = { k: state.encKeyId };
  }

  return manifest;
}

function countEvents(timeline: readonly IndexEvent[], kind: IndexEvent["k"]): number {
  return timeline.reduce((total, event) => total + (event.k === kind ? 1 : 0), 0);
}
