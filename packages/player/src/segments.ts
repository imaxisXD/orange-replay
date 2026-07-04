import { parseSegment, segmentBatch } from "@orange-replay/shared/wire";
import type { SegmentRef } from "@orange-replay/shared/types";
import type { DecodeWorkerHost } from "./worker-host.ts";
import type { ReplayEvent, SegmentWindow } from "./types.ts";

export interface SegmentBatches {
  batches: Uint8Array[];
}

export async function decodeSegmentEvents(
  segmentBytes: Uint8Array,
  worker: DecodeWorkerHost,
): Promise<ReplayEvent[]> {
  const batches = sliceSegmentBatches(segmentBytes);
  const decoded = await Promise.all(batches.map((batch) => worker.decodeBatch(batch)));
  return mergeReplayEvents(decoded.flat());
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
