import { decodeIngestBody, parseSegment, segmentBatch } from "@orange-replay/shared/wire";
import { MAX_CHECKPOINTS_PER_SEGMENT } from "@orange-replay/shared/constants";
import type { BatchIndex, SegmentCheckpoint, SegmentRef } from "@orange-replay/shared/types";
import { EventType } from "rrweb";
import type { DecodeWorkerHost } from "./worker-host.ts";
import type { ReplayEvent, SegmentWindow } from "./types.ts";

export interface SegmentBatches {
  batches: Uint8Array[];
}

export interface DecodedReplayBatch {
  index: BatchIndex;
  events: ReplayEvent[];
  decodedBytes: number;
  segmentBatchIndex: number;
}

export const MAX_DECODED_SEGMENT_EVENTS = 100_000;
export const MAX_DECODED_SEGMENT_EVENT_BYTES = 32 * 1024 * 1024;

export async function decodeSegmentEvents(
  segmentBytes: Uint8Array,
  worker: DecodeWorkerHost,
): Promise<ReplayEvent[]> {
  const decoded = await decodeSegmentBatches(segmentBytes, worker);
  return mergeReplayEvents(decoded.flatMap((batch) => batch.events));
}

export async function decodeSegmentBatches(
  segmentBytes: Uint8Array,
  worker: DecodeWorkerHost,
): Promise<DecodedReplayBatch[]> {
  const batches = sliceSegmentBatches(segmentBytes);
  const decoded: DecodedReplayBatch[] = [];
  const budget = { events: 0, bytes: 0 };

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    if (batch === undefined) {
      continue;
    }
    const decodedBatch = await decodeSegmentBatch(batch, index, worker);
    addToSegmentBudget(budget, decodedBatch);
    decoded.push(decodedBatch);
  }

  return decoded.toSorted(compareDecodedReplayBatches);
}

export function sliceSegmentBatches(segmentBytes: Uint8Array): Uint8Array[] {
  const parsed = parseSegment(segmentBytes);
  const batches: Uint8Array[] = [];

  for (let index = 0; index < parsed.count; index += 1) {
    batches.push(segmentBatch(parsed, index));
  }

  return batches;
}

export function findSegmentIndex(
  segments: readonly SegmentRef[],
  startedAt: number,
  timeMs: number,
): number {
  if (segments.length === 0) {
    return -1;
  }

  const targetTime = startedAt + Math.max(0, timeMs);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      continue;
    }

    if (targetTime <= segment.t1) {
      return index;
    }
  }

  return segments.length - 1;
}

export function chooseSegmentWindow(
  segments: readonly SegmentRef[],
  activeIndex: number,
  options: { targetTimestamp?: number; replayTab?: string } = {},
): SegmentWindow {
  if (segments.length === 0 || activeIndex < 0 || activeIndex >= segments.length) {
    return { activeIndex: -1, startIndex: -1, neededIndexes: [], prefetchIndexes: [] };
  }

  const activeSegment = segments[activeIndex];
  const targetTimestamp = options.targetTimestamp ?? activeSegment?.t1 ?? Number.POSITIVE_INFINITY;
  const checkpoint = findNearestSegmentCheckpoint(
    segments,
    activeIndex,
    targetTimestamp,
    options.replayTab,
  );
  const startIndex = checkpoint?.segmentIndex ?? 0;
  const nextIndex = activeIndex + 1;
  return {
    activeIndex,
    startIndex,
    neededIndexes: Array.from(
      { length: activeIndex - startIndex + 1 },
      (_unused, index) => startIndex + index,
    ),
    prefetchIndexes: nextIndex < segments.length ? [nextIndex] : [],
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

export function findPrimaryReplayTab(segments: readonly SegmentRef[]): string | undefined {
  let first: { timestamp: number; tab: string; segmentIndex: number; batch: number } | undefined;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    for (const checkpoint of segments[segmentIndex]?.checkpoints ?? []) {
      if (
        first === undefined ||
        checkpoint.timestamp < first.timestamp ||
        (checkpoint.timestamp === first.timestamp && segmentIndex < first.segmentIndex) ||
        (checkpoint.timestamp === first.timestamp &&
          segmentIndex === first.segmentIndex &&
          checkpoint.batch < first.batch)
      ) {
        first = { ...checkpoint, segmentIndex };
      }
    }
  }

  return first?.tab;
}

export function eventsFromCheckpoint(
  events: readonly ReplayEvent[],
  timestamp: number,
): ReplayEvent[] {
  const checkpointIndex = events.findIndex(
    (event) => event.type === EventType.FullSnapshot && event.timestamp === timestamp,
  );
  if (checkpointIndex < 0) {
    throw new Error("Replay checkpoint does not match a full snapshot.");
  }
  return events.slice(checkpointIndex);
}

export function validateSegmentCheckpoints(
  segment: SegmentRef,
  batches: readonly DecodedReplayBatch[],
): void {
  for (const checkpoint of segment.checkpoints ?? []) {
    const batch = batches.find((candidate) => candidate.segmentBatchIndex === checkpoint.batch);
    if (
      batch === undefined ||
      batch.index.tab !== checkpoint.tab ||
      !batch.index.checkpointTimestamps?.includes(checkpoint.timestamp) ||
      !batch.events.some(
        (event) =>
          event.type === EventType.FullSnapshot && event.timestamp === checkpoint.timestamp,
      )
    ) {
      throw new Error("Replay segment checkpoint metadata does not match its full snapshot.");
    }
  }
}

export function discoverSegmentCheckpoints(
  batches: readonly DecodedReplayBatch[],
): SegmentCheckpoint[] {
  const checkpoints: SegmentCheckpoint[] = [];
  for (const batch of batches) {
    for (const event of batch.events) {
      if (event.type !== EventType.FullSnapshot) {
        continue;
      }
      checkpoints.push({
        timestamp: event.timestamp,
        tab: batch.index.tab,
        batch: batch.segmentBatchIndex,
      });
      if (checkpoints.length >= MAX_CHECKPOINTS_PER_SEGMENT) {
        return checkpoints;
      }
    }
  }
  return checkpoints.toSorted(
    (left, right) => left.timestamp - right.timestamp || left.batch - right.batch,
  );
}

export function mergeReplayEvents(events: readonly ReplayEvent[]): ReplayEvent[] {
  return [...events].sort((left, right) => left.timestamp - right.timestamp);
}

async function decodeSegmentBatch(
  batch: Uint8Array,
  batchNumber: number,
  worker: DecodeWorkerHost,
): Promise<DecodedReplayBatch> {
  let encoded:
    | {
        index: BatchIndex;
        payload: Uint8Array;
      }
    | undefined;
  try {
    encoded = decodeIngestBody(batch);
  } catch {
    encoded = undefined;
  }

  if (encoded !== undefined) {
    return {
      index: encoded.index,
      segmentBatchIndex: batchNumber,
      ...(await worker.decodeBatchWithStats(encoded.payload)),
    };
  }

  const decoded = await worker.decodeBatchWithStats(batch);
  return {
    decodedBytes: decoded.decodedBytes,
    events: decoded.events,
    index: legacyBatchIndex(decoded.events, batchNumber),
    segmentBatchIndex: batchNumber,
  };
}

function findNearestSegmentCheckpoint(
  segments: readonly SegmentRef[],
  activeIndex: number,
  targetTimestamp: number,
  replayTab: string | undefined,
): SegmentWindow["checkpoint"] {
  let nearest: SegmentWindow["checkpoint"];

  for (let segmentIndex = 0; segmentIndex <= activeIndex; segmentIndex += 1) {
    for (const checkpoint of segments[segmentIndex]?.checkpoints ?? []) {
      if (checkpoint.timestamp > targetTimestamp || (replayTab && checkpoint.tab !== replayTab)) {
        continue;
      }
      if (
        nearest === undefined ||
        checkpoint.timestamp > nearest.timestamp ||
        (checkpoint.timestamp === nearest.timestamp && segmentIndex > nearest.segmentIndex) ||
        (checkpoint.timestamp === nearest.timestamp &&
          segmentIndex === nearest.segmentIndex &&
          checkpoint.batch > nearest.batch)
      ) {
        nearest = { ...checkpoint, segmentIndex };
      }
    }
  }

  return nearest;
}

function legacyBatchIndex(events: readonly ReplayEvent[], batchNumber: number): BatchIndex {
  const times = events
    .map((event) => event.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp));
  const t0 = times.length === 0 ? 0 : Math.min(...times);
  const t1 = times.length === 0 ? t0 : Math.max(...times);

  return {
    v: 1,
    s: "legacy",
    tab: "legacy",
    seq: batchNumber,
    t0,
    t1,
    e: [],
  };
}

function compareDecodedReplayBatches(left: DecodedReplayBatch, right: DecodedReplayBatch): number {
  return (
    left.index.t0 - right.index.t0 ||
    left.index.tab.localeCompare(right.index.tab) ||
    left.index.seq - right.index.seq
  );
}

function addToSegmentBudget(
  budget: { events: number; bytes: number },
  decodedBatch: DecodedReplayBatch,
): void {
  const events = decodedBatch.events;
  budget.events += events.length;
  if (budget.events > MAX_DECODED_SEGMENT_EVENTS) {
    throw new Error("Replay segment has too many events.");
  }

  budget.bytes += decodedBatch.decodedBytes;
  if (budget.bytes > MAX_DECODED_SEGMENT_EVENT_BYTES) {
    throw new Error("Replay segment is too large after decoding.");
  }
}
