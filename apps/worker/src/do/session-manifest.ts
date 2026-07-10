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

export function countTimelineEvents(segments: readonly SegmentForManifest[]): number {
  return segments.reduce((total, segment) => total + segment.events.length, 0);
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
  const endedAt = Math.max(state.lastActivity, ...segments.map((segment) => segment.t1));
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
    startedAt: state.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - state.startedAt),
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
