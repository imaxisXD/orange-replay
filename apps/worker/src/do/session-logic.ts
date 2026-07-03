import {
  CLOSE_SESSION_AFTER_IDLE_MS,
  FLUSH_TAIL_AFTER_IDLE_MS,
  MAX_BATCHES_PER_SEGMENT,
  MAX_SEQ,
  SDK_FLUSH_DEFAULT_MS,
  SDK_FLUSH_LIVE_MS,
  SEGMENT_FLUSH_BYTES,
  SEGMENT_FLUSH_INTERVAL_MS,
} from "@orange-replay/shared";
import type {
  BatchIndex,
  EdgeAttrs,
  FinalizeMessage,
  IndexEvent,
  SegmentRef,
  SessionManifest,
} from "@orange-replay/shared";

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

export const CLIENT_TIME_PAST_WINDOW_MS = 86_400_000;
export const CLIENT_TIME_FUTURE_WINDOW_MS = 60_000;
export const FINALIZE_MESSAGE_BUDGET_BYTES = 100_000;
export const MAX_MANIFEST_TIMELINE_EVENTS = 10_000;
export const MAX_SESSION_STORED_BYTES = 512 * 1024 * 1024;

const utf8Encoder = new TextEncoder();

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

export function shouldSetAlarm(input: {
  alarmAt: number | null;
  now: number;
  desiredAt: number;
  flushTailMs: number;
}): boolean {
  return (
    input.alarmAt === null ||
    input.alarmAt <= input.now ||
    input.alarmAt > input.desiredAt + 2 * input.flushTailMs
  );
}

export function nextAlarmAfterAlarm(input: {
  lastActivity: number;
  pendingBatches: number;
  timing: SessionTiming;
}): number {
  if (input.pendingBatches > 0) {
    return input.lastActivity + input.timing.flushTailMs;
  }

  return input.lastActivity + input.timing.closeMs;
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
    .toSorted((left, right) => left.t - right.t)
    .slice(0, MAX_MANIFEST_TIMELINE_EVENTS);
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
  const errors = copyFinalizeEvents(timeline, "error");
  const customs = copyFinalizeEvents(timeline, "custom");

  return [...errors, ...customs].slice(0, 200);
}

export function capFinalizeMessageToBudget(
  message: FinalizeMessage,
  budgetBytes = FINALIZE_MESSAGE_BUDGET_BYTES,
): FinalizeMessage {
  const capped: FinalizeMessage = { ...message, events: [...message.events] };

  while (serializedBytes(capped) > budgetBytes && capped.events.length > 0) {
    capped.events.pop();
  }

  return capped;
}

export function countTimelineEvents(segments: readonly SegmentForManifest[]): number {
  return segments.reduce((total, segment) => total + segment.events.length, 0);
}

export function chunkForSegments<T>(
  rows: readonly T[],
  maxBatchesPerSegment = MAX_BATCHES_PER_SEGMENT,
): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < rows.length; index += maxBatchesPerSegment) {
    chunks.push(rows.slice(index, index + maxBatchesPerSegment));
  }

  return chunks;
}

export function clampIndexForStorage(
  index: BatchIndex,
  startedAt: number,
  receivedAt: number,
): BatchIndex {
  const minTime = startedAt - CLIENT_TIME_PAST_WINDOW_MS;
  const maxTime = receivedAt + CLIENT_TIME_FUTURE_WINDOW_MS;
  const t0 = clamp(index.t0, minTime, maxTime);
  const t1 = Math.max(t0, clamp(index.t1, minTime, maxTime));

  return {
    ...index,
    t0,
    t1,
    e: index.e.map((event) => ({
      ...event,
      t: clamp(event.t, minTime, maxTime),
    })),
  };
}

export function shouldDropForSessionCap(input: {
  totalPayloadBytes: number;
  batchCount: number;
  payloadBytes: number;
}): boolean {
  return (
    input.batchCount >= MAX_SEQ ||
    input.totalPayloadBytes + input.payloadBytes > MAX_SESSION_STORED_BYTES
  );
}

function countEvents(timeline: readonly IndexEvent[], kind: IndexEvent["k"]): number {
  return timeline.reduce((total, event) => total + (event.k === kind ? 1 : 0), 0);
}

function copyFinalizeEvents(
  timeline: readonly IndexEvent[],
  kind: "error" | "custom",
): IndexEvent[] {
  const events: IndexEvent[] = [];

  for (const event of timeline) {
    if (event.k !== kind) {
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

function serializedBytes(value: unknown): number {
  return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
