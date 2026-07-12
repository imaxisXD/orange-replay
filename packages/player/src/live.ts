import { decodeIngestBody } from "@orange-replay/shared/wire";
import type {
  BatchIndex,
  LiveHelloMessage,
  LiveSessionSnapshot,
  SessionCounts,
} from "@orange-replay/shared/types";
import { EventType } from "rrweb";
import type { ReplayEvent } from "./types.ts";

export interface LiveFrame {
  index: BatchIndex;
  payload: Uint8Array;
}

export interface LiveFrameState {
  seen: Set<string>;
}

export function parseLiveHelloMessage(value: string): LiveHelloMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed["type"] !== "hello") return null;
  if (
    readLiveSnapshot(parsed["snapshot"]) === null ||
    typeof parsed["sessionId"] !== "string" ||
    !Number.isFinite(parsed["startedAt"]) ||
    !Array.isArray(parsed["segments"]) ||
    !isNonnegativeNumber(parsed["pendingBatches"])
  ) {
    return null;
  }

  return parsed as unknown as LiveHelloMessage;
}

export interface LiveKeyframeBuffer {
  waiting: boolean;
  started: boolean;
  events: ReplayEvent[];
  batches: BufferedLiveReplayBatch[];
  nextOrder: number;
  estimatedBytes: number;
  waitingStartedAt: number;
}

const LIVE_SEEN_KEY_LIMIT = 4_096;
const DEFAULT_KEYFRAME_EVENT_LIMIT = 5_000;
const DEFAULT_KEYFRAME_BYTE_LIMIT = 512 * 1024;
const DEFAULT_KEYFRAME_WAIT_MS = 15_000;

export interface LiveKeyframeLimits {
  maxBytes?: number;
  maxEvents?: number;
  maxWaitMs?: number;
  now?: number;
}

export type LiveKeyframeAcceptStatus = "accepted" | "overflow" | "waiting";

export interface LiveKeyframeAcceptResult {
  events: ReplayEvent[];
  status: LiveKeyframeAcceptStatus;
}

export interface LiveReplayBatch {
  tab: string;
  seq: number;
  events: readonly ReplayEvent[];
}

interface BufferedLiveReplayBatch {
  tab: string;
  seq: number;
  order: number;
  events: ReplayEvent[];
}

export function createLiveFrameState(): LiveFrameState {
  return {
    seen: new Set(),
  };
}

export function createLiveKeyframeBuffer(): LiveKeyframeBuffer {
  return {
    waiting: false,
    started: false,
    events: [],
    batches: [],
    nextOrder: 0,
    estimatedBytes: 0,
    waitingStartedAt: 0,
  };
}

export function startWaitingForKeyframe(buffer: LiveKeyframeBuffer, now = Date.now()): void {
  buffer.waiting = true;
  buffer.started = false;
  buffer.events = [];
  buffer.batches = [];
  buffer.nextOrder = 0;
  buffer.estimatedBytes = 0;
  buffer.waitingStartedAt = now;
}

export function stopWaitingForKeyframe(buffer: LiveKeyframeBuffer): void {
  buffer.waiting = false;
  buffer.started = false;
  buffer.events = [];
  buffer.batches = [];
  buffer.nextOrder = 0;
  buffer.estimatedBytes = 0;
  buffer.waitingStartedAt = 0;
}

export function acceptLiveEventsAfterKeyframe(
  buffer: LiveKeyframeBuffer,
  events: readonly ReplayEvent[],
): ReplayEvent[] {
  return acceptLiveEventsAfterKeyframeWithStatus(buffer, events).events;
}

export function acceptLiveEventsAfterKeyframeWithStatus(
  buffer: LiveKeyframeBuffer,
  events: readonly ReplayEvent[],
  limits: LiveKeyframeLimits = {},
): LiveKeyframeAcceptResult {
  return acceptLiveEventBatchAfterKeyframeWithStatus(
    buffer,
    { tab: "legacy", seq: buffer.nextOrder, events },
    limits,
  );
}

export function acceptLiveEventBatchAfterKeyframeWithStatus(
  buffer: LiveKeyframeBuffer,
  batch: LiveReplayBatch,
  limits: LiveKeyframeLimits = {},
): LiveKeyframeAcceptResult {
  if (!buffer.waiting || buffer.started) {
    return { events: [...batch.events], status: "accepted" };
  }

  buffer.batches.push({
    tab: batch.tab,
    seq: batch.seq,
    order: buffer.nextOrder,
    events: [...batch.events],
  });
  buffer.nextOrder += 1;
  buffer.batches.sort(compareBufferedLiveReplayBatches);
  buffer.events = buffer.batches.flatMap((stored) => stored.events);
  buffer.estimatedBytes += estimateReplayBytes(batch.events);

  const snapshotIndex = buffer.events.findIndex(isFullSnapshotEvent);
  if (snapshotIndex < 0) {
    if (keyframeBufferExceededLimit(buffer, limits)) {
      startWaitingForKeyframe(buffer, limits.now);
      return { events: [], status: "overflow" };
    }

    return { events: [], status: "waiting" };
  }

  const startIndex =
    snapshotIndex > 0 && isMetaEvent(buffer.events[snapshotIndex - 1])
      ? snapshotIndex - 1
      : snapshotIndex;
  const acceptedEvents = buffer.events.slice(startIndex);
  buffer.events = [];
  buffer.batches = [];
  buffer.nextOrder = 0;
  buffer.estimatedBytes = 0;
  buffer.started = true;
  buffer.waiting = false;
  buffer.waitingStartedAt = 0;
  return { events: acceptedEvents, status: "accepted" };
}

export function acceptLiveFrame(
  state: LiveFrameState,
  bytes: ArrayBuffer | Uint8Array,
): LiveFrame | null {
  const frame = decodeLiveFrame(bytes);
  const key = liveFrameKey(frame.index);

  if (state.seen.has(key)) {
    return null;
  }

  state.seen.add(key);
  pruneSeenKeys(state.seen);
  return frame;
}

export function decodeLiveFrame(bytes: ArrayBuffer | Uint8Array): LiveFrame {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return decodeIngestBody(view);
}

export function retainLiveReplayEvents(
  events: readonly ReplayEvent[],
  cutoffTimestamp: number,
): ReplayEvent[] {
  const cutoffIndex = events.findIndex((event) => event.timestamp >= cutoffTimestamp);
  if (cutoffIndex <= 0) {
    return [...events];
  }

  let snapshotIndex = -1;
  for (let index = cutoffIndex - 1; index >= 0; index -= 1) {
    if (isFullSnapshotEvent(events[index]!)) {
      snapshotIndex = index;
      break;
    }
  }

  const baselineStart =
    snapshotIndex > 0 && isMetaEvent(events[snapshotIndex - 1]) ? snapshotIndex - 1 : snapshotIndex;
  return baselineStart >= 0 ? events.slice(baselineStart) : events.slice(cutoffIndex);
}

export function liveFrameKey(index: BatchIndex): string {
  return `${index.tab}:${index.seq}`;
}

function pruneSeenKeys(seen: Set<string>): void {
  while (seen.size > LIVE_SEEN_KEY_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) {
      return;
    }
    seen.delete(oldest);
  }
}

function isFullSnapshotEvent(event: ReplayEvent): boolean {
  return event.type === EventType.FullSnapshot;
}

function isMetaEvent(event: ReplayEvent | undefined): boolean {
  return event?.type === EventType.Meta;
}

function keyframeBufferExceededLimit(
  buffer: LiveKeyframeBuffer,
  limits: LiveKeyframeLimits,
): boolean {
  const maxEvents = limits.maxEvents ?? DEFAULT_KEYFRAME_EVENT_LIMIT;
  const maxBytes = limits.maxBytes ?? DEFAULT_KEYFRAME_BYTE_LIMIT;
  const maxWaitMs = limits.maxWaitMs ?? DEFAULT_KEYFRAME_WAIT_MS;
  const now = limits.now ?? Date.now();
  const waitedMs = buffer.waitingStartedAt > 0 ? Math.max(0, now - buffer.waitingStartedAt) : 0;

  return (
    buffer.events.length > maxEvents || buffer.estimatedBytes > maxBytes || waitedMs > maxWaitMs
  );
}

function estimateReplayBytes(events: readonly ReplayEvent[]): number {
  let total = 0;
  for (const event of events) {
    try {
      total += JSON.stringify(event).length;
    } catch {
      total += 1_024;
    }
  }
  return total;
}

function readLiveSnapshot(value: unknown): LiveSessionSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !Number.isFinite(value["startedAt"]) ||
    !Number.isFinite(value["endedAt"]) ||
    !isNonnegativeNumber(value["durationMs"]) ||
    !Array.isArray(value["timeline"]) ||
    !isSessionCounts(value["counts"])
  ) {
    return null;
  }
  return value as unknown as LiveSessionSnapshot;
}

function isSessionCounts(value: unknown): value is SessionCounts {
  if (!isRecord(value)) return false;
  return ["batches", "events", "clicks", "errors", "rages", "navs"].every((key) =>
    isNonnegativeNumber(value[key]),
  );
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareBufferedLiveReplayBatches(
  left: BufferedLiveReplayBatch,
  right: BufferedLiveReplayBatch,
): number {
  return left.tab.localeCompare(right.tab) || left.seq - right.seq || left.order - right.order;
}
