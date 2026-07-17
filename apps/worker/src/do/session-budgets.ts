import {
  MAX_BATCHES_PER_SEGMENT,
  MAX_ENCODED_SEGMENT_BYTES,
  MAX_MANIFEST_SEGMENTS,
  MAX_SEQ,
} from "@orange-replay/shared";
import type { BatchIndex, FinalizeMessage, IndexEvent } from "@orange-replay/shared";

export const CLIENT_TIME_PAST_WINDOW_MS = 86_400_000;
export const CLIENT_TIME_FUTURE_WINDOW_MS = 60_000;
export const FINALIZE_MESSAGE_BUDGET_BYTES = 100_000;
export const MAX_MANIFEST_TIMELINE_EVENTS = 10_000;
export const MAX_SEGMENT_TIMELINE_BYTES = 128 * 1024;
export const MAX_MANIFEST_TIMELINE_BYTES = 256 * 1024;
export const MAX_SESSION_STORED_BYTES = 512 * 1024 * 1024;
export const MAX_SESSION_EVENT_BYTES = 64 * 1024 * 1024;
// Bounds the synchronous work needed to finalize one Durable Object. At the
// default SDK flush interval this still permits more than eight continuous days.
export const MAX_SESSION_BATCHES = 50_000;
// Full analytics are deliberately lower than the storage cap. Each sanitized
// batch may carry up to 16 KiB of event metadata, so these limits keep a
// finalization pass near 8 MiB and skip the second sidecar pass above them.
export const MAX_FINALIZE_ANALYTICS_BATCHES = 512;
export const MAX_FINALIZE_ANALYTICS_EVENT_BYTES = 8 * 1024 * 1024;
// The recovery intent shares a Durable Object SQLite row with metadata.
// Keep its body below the platform row limit with room for those fields.
export const MAX_SEGMENT_INTENT_BODY_BYTES = 1_500_000;

const utf8Encoder = new TextEncoder();

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

export function capTimelineEventsToBudget(
  events: readonly IndexEvent[],
  maxEvents = MAX_MANIFEST_TIMELINE_EVENTS,
  budgetBytes = MAX_SEGMENT_TIMELINE_BYTES,
): IndexEvent[] {
  const indexedEvents = events.map((event, index) => ({ event, index }));
  const prioritized = [
    ...indexedEvents.filter(({ event }) => isNotableTimelineEvent(event)),
    ...indexedEvents.filter(({ event }) => !isNotableTimelineEvent(event)),
  ];
  const kept = new Set<number>();
  let bytesUsed = 2;

  for (const candidate of prioritized) {
    if (kept.size >= maxEvents) {
      break;
    }

    const eventBytes = serializedBytes(candidate.event);
    const nextBytes = bytesUsed + eventBytes + (kept.size === 0 ? 0 : 1);
    if (nextBytes > budgetBytes) {
      continue;
    }

    kept.add(candidate.index);
    bytesUsed = nextBytes;
  }

  return indexedEvents.filter(({ index }) => kept.has(index)).map(({ event }) => event);
}

export function chunkForSegments<T>(
  rows: readonly T[],
  options: {
    maxBatchesPerSegment?: number;
    maxEncodedSegmentBytes?: number;
    readBatchBytes?: (row: T) => number;
  } = {},
): T[][] {
  const maxBatchesPerSegment = options.maxBatchesPerSegment ?? MAX_BATCHES_PER_SEGMENT;
  const maxEncodedSegmentBytes = options.maxEncodedSegmentBytes ?? MAX_ENCODED_SEGMENT_BYTES;
  const readBatchBytes = options.readBatchBytes ?? (() => 0);
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let chunkBytes = 8;

  for (const row of rows) {
    const batchBytes = Math.max(0, Math.floor(readBatchBytes(row)));
    const standaloneSegmentBytes = 8 + 4 + batchBytes;
    if (!Number.isFinite(batchBytes) || standaloneSegmentBytes > maxEncodedSegmentBytes) {
      throw new Error("Replay batch is too large to store in a playable segment.");
    }

    if (
      chunk.length >= maxBatchesPerSegment ||
      (chunk.length > 0 && chunkBytes + 4 + batchBytes > maxEncodedSegmentBytes)
    ) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 8;
    }

    chunk.push(row);
    chunkBytes += 4 + batchBytes;
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
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
    ...(index.checkpointTimestamps === undefined
      ? {}
      : {
          checkpointTimestamps: index.checkpointTimestamps.map((timestamp) =>
            clamp(timestamp, t0, t1),
          ),
        }),
  };
}

export function shouldDropForSessionCap(input: {
  totalPayloadBytes: number;
  totalEventBytes: number;
  batchCount: number;
  segmentCount: number;
  payloadBytes: number;
  eventBytes: number;
}): boolean {
  return (
    input.batchCount >= Math.min(MAX_SEQ, MAX_SESSION_BATCHES) ||
    input.segmentCount >= MAX_MANIFEST_SEGMENTS ||
    input.totalEventBytes + input.eventBytes > MAX_SESSION_EVENT_BYTES ||
    input.totalPayloadBytes + input.payloadBytes + input.totalEventBytes + input.eventBytes >
      MAX_SESSION_STORED_BYTES
  );
}

function isNotableTimelineEvent(event: IndexEvent): boolean {
  return (
    event.k === "error" ||
    event.k === "rage" ||
    event.k === "nav" ||
    (event.k === "vital" && event.d === "navigation" && typeof event.m?.["url"] === "string")
  );
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
  // Analytics stores millisecond times as int64. Normalize public ingest
  // numbers here so one fractional client timestamp cannot poison export.
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
