import type { BatchIndex, IndexEvent, SegmentCheckpoint } from "@orange-replay/shared";

export interface StoredBatchMetadata {
  events: IndexEvent[];
  checkpointTimestamps: number[];
}

export interface StoredSegmentMetadata {
  events: IndexEvent[];
  checkpoints: SegmentCheckpoint[];
}

export function encodeStoredBatchMetadata(
  index: Pick<BatchIndex, "e" | "checkpointTimestamps">,
): string {
  const checkpointTimestamps = index.checkpointTimestamps ?? [];
  if (checkpointTimestamps.length === 0) {
    return JSON.stringify(index.e);
  }

  return JSON.stringify({
    events: index.e,
    checkpointTimestamps,
  });
}

export function parseStoredBatchMetadata(raw: string): StoredBatchMetadata {
  const parsed = parseMetadata(raw);
  if (Array.isArray(parsed)) {
    return { events: parsed as IndexEvent[], checkpointTimestamps: [] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["events"])) {
    return { events: [], checkpointTimestamps: [] };
  }

  const checkpointTimestamps = Array.isArray(parsed["checkpointTimestamps"])
    ? parsed["checkpointTimestamps"].filter(isFiniteNumber)
    : [];
  return {
    events: parsed["events"] as IndexEvent[],
    checkpointTimestamps,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
