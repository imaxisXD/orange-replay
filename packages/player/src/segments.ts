import { decodeIngestBody, parseSegment, segmentBatch } from "@orange-replay/shared/wire";
import type { BatchIndex, SegmentRef } from "@orange-replay/shared/types";
import type { DecodeWorkerHost } from "./worker-host.ts";
import type { ReplayEvent, SegmentWindow } from "./types.ts";

export interface SegmentBatches {
  batches: Uint8Array[];
}

export interface DecodedReplayBatch {
  index: BatchIndex;
  events: ReplayEvent[];
  decodedBytes: number;
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
): SegmentWindow {
  if (segments.length === 0 || activeIndex < 0 || activeIndex >= segments.length) {
    return { activeIndex: -1, neededIndexes: [], prefetchIndexes: [] };
  }

  const nextIndex = activeIndex + 1;
  return {
    activeIndex,
    neededIndexes: [activeIndex],
    prefetchIndexes: nextIndex < segments.length ? [nextIndex] : [],
  };
}

export function mergeReplayEvents(events: readonly ReplayEvent[]): ReplayEvent[] {
  return [...events].sort((left, right) => left.timestamp - right.timestamp);
}

export function eventKey(event: ReplayEvent): string {
  return `${event.timestamp}:${event.type}:${JSON.stringify(event.data)}`;
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
      ...(await worker.decodeBatchWithStats(encoded.payload)),
    };
  }

  const decoded = await worker.decodeBatchWithStats(batch);
  return {
    decodedBytes: decoded.decodedBytes,
    events: decoded.events,
    index: legacyBatchIndex(decoded.events, batchNumber),
  };
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
