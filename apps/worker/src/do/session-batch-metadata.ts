import { MAX_CHECKPOINTS_PER_SEGMENT } from "@orange-replay/shared";
import type { BatchIndex, IndexEvent, SegmentCheckpoint } from "@orange-replay/shared";

export interface StoredBatchMetadata {
  events: IndexEvent[];
  checkpointTimestamps: number[];
  pageAnalyticsVersion: 0 | 1;
  url?: string;
}

export interface StoredSegmentMetadata {
  events: IndexEvent[];
  checkpoints: SegmentCheckpoint[];
}

export function encodeStoredBatchMetadata(
  index: Pick<BatchIndex, "e" | "checkpointTimestamps" | "u">,
): string {
  const checkpointTimestamps = index.checkpointTimestamps ?? [];
  const url = nonEmptyText(index.u);
  return JSON.stringify({
    pageAnalyticsVersion: 1,
    events: index.e,
    ...(checkpointTimestamps.length === 0 ? {} : { checkpointTimestamps }),
    ...(url === undefined ? {} : { url }),
  });
}

export function parseStoredBatchMetadata(raw: string): StoredBatchMetadata {
  const parsed = parseMetadata(raw);
  if (Array.isArray(parsed)) {
    return { events: parsed as IndexEvent[], checkpointTimestamps: [], pageAnalyticsVersion: 0 };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["events"])) {
    return { events: [], checkpointTimestamps: [], pageAnalyticsVersion: 0 };
  }

  const checkpointTimestamps = Array.isArray(parsed["checkpointTimestamps"])
    ? parsed["checkpointTimestamps"].filter(isFiniteNumber)
    : [];
  const url = nonEmptyText(parsed["url"]);
  return {
    events: parsed["events"] as IndexEvent[],
    checkpointTimestamps,
    pageAnalyticsVersion: parsed["pageAnalyticsVersion"] === 1 ? 1 : 0,
    ...(url === undefined ? {} : { url }),
  };
}

export function encodeStoredSegmentMetadata(
  events: readonly IndexEvent[],
  checkpoints: readonly SegmentCheckpoint[],
): string {
  if (checkpoints.length === 0) {
    return JSON.stringify(events);
  }

  return JSON.stringify({ events, checkpoints });
}

export function parseStoredSegmentMetadata(raw: string): StoredSegmentMetadata {
  const parsed = parseMetadata(raw);
  if (Array.isArray(parsed)) {
    return { events: parsed as IndexEvent[], checkpoints: [] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["events"])) {
    return { events: [], checkpoints: [] };
  }

  const checkpoints = Array.isArray(parsed["checkpoints"])
    ? parsed["checkpoints"].filter(isSegmentCheckpoint)
    : [];
  return {
    events: parsed["events"] as IndexEvent[],
    checkpoints,
  };
}

/** Parses the checkpoint-only JSON selected by the finalization query. */
export function parseStoredSegmentCheckpoints(raw: string): SegmentCheckpoint[] {
  const parsed = parseMetadata(raw);
  if (!Array.isArray(parsed)) return [];

  const checkpoints = parsed.filter(isSegmentCheckpoint);
  if (checkpoints.length > MAX_CHECKPOINTS_PER_SEGMENT) {
    throw new Error("Stored segment has too many checkpoints.");
  }
  return checkpoints;
}

export function parseStoredSidecarEvents(raw: string): IndexEvent[] {
  const parsed = parseMetadata(raw);
  if (Array.isArray(parsed)) {
    return parsed as IndexEvent[];
  }
  if (isRecord(parsed) && Array.isArray(parsed["events"])) {
    return parsed["events"] as IndexEvent[];
  }
  return [];
}

function parseMetadata(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function isSegmentCheckpoint(value: unknown): value is SegmentCheckpoint {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isFiniteNumber(value["timestamp"]) &&
    typeof value["tab"] === "string" &&
    value["tab"].length > 0 &&
    typeof value["batch"] === "number" &&
    Number.isSafeInteger(value["batch"]) &&
    value["batch"] >= 0
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
