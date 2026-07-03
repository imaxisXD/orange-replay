import {
  CLOSE_SESSION_AFTER_IDLE_MS,
  FLUSH_TAIL_AFTER_IDLE_MS,
  SDK_FLUSH_DEFAULT_MS,
  SDK_FLUSH_LIVE_MS,
  SEGMENT_FLUSH_BYTES,
  SEGMENT_FLUSH_INTERVAL_MS,
} from "@orange-replay/shared";
import type { EdgeAttrs, IndexEvent, SegmentRef, SessionManifest } from "@orange-replay/shared";

export interface SessionTiming {
  segmentFlushBytes: number;
  segmentFlushMs: number;
  flushTailMs: number;
  closeMs: number;
}

export interface SessionState {
  projectId: string;
  orgId: string;
  shard: number;
  retentionDays: number;
  sessionId: string;
  startedAt: number;
  lastActivity: number;
  lastFlushAt: number;
  bufferedBytes: number;
  totalPayloadBytes: number;
  batchCount: number;
  segmentCount: number;
  flags: number;
  attrs: EdgeAttrs;
  firstRequestId: string;
  entryUrl?: string;
  urls: string[];
  urlCount: number;
  encKeyId?: string;
}

export type AppendFlushReason = "bytes" | "interval";
export type SegmentFlushReason = AppendFlushReason | "tail_flush" | "finalize";

export interface FlushDecision {
  shouldFlush: boolean;
  reason?: AppendFlushReason;
}

export interface SegmentForManifest extends SegmentRef {
  events: IndexEvent[];
}

export const defaultSessionTiming: SessionTiming = {
  segmentFlushBytes: SEGMENT_FLUSH_BYTES,
  segmentFlushMs: SEGMENT_FLUSH_INTERVAL_MS,
  flushTailMs: FLUSH_TAIL_AFTER_IDLE_MS,
  closeMs: CLOSE_SESSION_AFTER_IDLE_MS,
};

export function resolveSessionTiming(
  devTestRoutes: string | undefined,
  rawOverride: string | undefined,
): SessionTiming {
  if (devTestRoutes !== "1" || rawOverride === undefined || rawOverride.trim() === "") {
    return { ...defaultSessionTiming };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOverride);
  } catch {
    return { ...defaultSessionTiming };
  }

  if (!isRecord(parsed)) {
    return { ...defaultSessionTiming };
  }

  return {
    segmentFlushBytes: readPositiveNumber(parsed["segmentFlushBytes"], SEGMENT_FLUSH_BYTES),
    segmentFlushMs: readPositiveNumber(parsed["segmentFlushMs"], SEGMENT_FLUSH_INTERVAL_MS),
    flushTailMs: readPositiveNumber(parsed["flushTailMs"], FLUSH_TAIL_AFTER_IDLE_MS),
    closeMs: readPositiveNumber(parsed["closeMs"], CLOSE_SESSION_AFTER_IDLE_MS),
  };
}

export function decideSegmentFlush(input: {
  bufferedBytes: number;
  pendingBatches: number;
  receivedAt: number;
  lastFlushAt: number;
  timing: SessionTiming;
}): FlushDecision {
  if (input.pendingBatches < 1) {
    return { shouldFlush: false };
  }

  if (input.bufferedBytes >= input.timing.segmentFlushBytes) {
    return { shouldFlush: true, reason: "bytes" };
  }

  if (input.receivedAt - input.lastFlushAt >= input.timing.segmentFlushMs) {
    return { shouldFlush: true, reason: "interval" };
  }

  return { shouldFlush: false };
}

export function sdkFlushMs(live: boolean): number {
  return live ? SDK_FLUSH_LIVE_MS : SDK_FLUSH_DEFAULT_MS;
}

export function buildSessionManifest(
  state: SessionState,
  segments: readonly SegmentForManifest[],
): SessionManifest {
  const timeline = segments
    .flatMap((segment) => segment.events)
    .toSorted((left, right) => left.t - right.t);
  const endedAt = Math.max(state.lastActivity, ...segments.map((segment) => segment.t1));
  const attrs: SessionManifest["attrs"] = { ...state.attrs };

  if (state.entryUrl !== undefined) {
    attrs.entryUrl = state.entryUrl;
  }
  if (state.urlCount > 0) {
    attrs.urlCount = state.urlCount;
  }

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
      events: timeline.length,
      clicks: countEvents(timeline, "click"),
      errors: countEvents(timeline, "error"),
      rages: countEvents(timeline, "rage"),
      navs: countEvents(timeline, "nav"),
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

export function filterFinalizeEvents(timeline: readonly IndexEvent[]): IndexEvent[] {
  const events: IndexEvent[] = [];

  for (const event of timeline) {
    if (event.k !== "error" && event.k !== "custom") {
      continue;
    }

    const nextEvent = { ...event };
    if (typeof nextEvent.d === "string" && nextEvent.d.length > 200) {
      nextEvent.d = nextEvent.d.slice(0, 200);
    }

    events.push(nextEvent);
    if (events.length >= 200) {
      break;
    }
  }

  return events;
}

function countEvents(timeline: readonly IndexEvent[], kind: IndexEvent["k"]): number {
  return timeline.reduce((total, event) => total + (event.k === kind ? 1 : 0), 0);
}

function readPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
