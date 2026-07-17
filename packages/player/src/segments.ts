import { decodeIngestBody, parseSegment, segmentBatch } from "@orange-replay/shared/wire";
import { MAX_CHECKPOINTS_PER_SEGMENT } from "@orange-replay/shared/constants";
import type { BatchIndex, SegmentCheckpoint, SegmentRef } from "@orange-replay/shared/types";
import { EventType } from "rrweb";
import { replayViewportFromEvent } from "./geometry.ts";
import { validateReplayEventTimesAgainstIndex } from "./replay-event-validation.ts";
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
export const MAX_REPLAY_HISTORY_EVENTS = 250_000;
export const MAX_REPLAY_HISTORY_DECODED_BYTES = 128 * 1024 * 1024;
export const MAX_REPLAY_HISTORY_BATCHES = 4_096;
export const MAX_REPLAY_TAB_DISCOVERY_EVENTS = 100_000;
export const MAX_REPLAY_TAB_DISCOVERY_DECODED_BYTES = 64 * 1024 * 1024;
export const MAX_REPLAY_TAB_DISCOVERY_BATCHES = 512;

export interface ReplayHistoryDecodeState {
  activeTab?: string;
  batches: DecodedReplayBatch[];
  activeEvents: number;
  activeDecodedBytes: number;
  activeBatches: number;
  discoveryEvents: number;
  discoveryDecodedBytes: number;
  discoveryBatches: number;
}

export function createReplayHistoryDecodeState(activeTab?: string): ReplayHistoryDecodeState {
  return {
    ...(activeTab === undefined ? {} : { activeTab }),
    batches: [],
    activeEvents: 0,
    activeDecodedBytes: 0,
    activeBatches: 0,
    discoveryEvents: 0,
    discoveryDecodedBytes: 0,
    discoveryBatches: 0,
  };
}

export async function decodeSegmentEvents(
  segmentBytes: Uint8Array,
  worker: DecodeWorkerHost,
  trustedTimeRange?: Pick<SegmentRef, "t0" | "t1">,
): Promise<ReplayEvent[]> {
  const decoded = await decodeSegmentBatches(segmentBytes, worker, trustedTimeRange);
  return mergeReplayEvents(decoded.flatMap((batch) => batch.events));
}

export async function decodeSegmentBatches(
  segmentBytes: Uint8Array,
  worker: DecodeWorkerHost,
  trustedTimeRange?: Pick<SegmentRef, "t0" | "t1">,
): Promise<DecodedReplayBatch[]> {
  const batches = sliceSegmentBatches(segmentBytes);
  const decoded: DecodedReplayBatch[] = [];
  const budget = { events: 0, bytes: 0 };

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    if (batch === undefined) {
      continue;
    }
    const decodedBatch = await decodeSegmentBatch(batch, index, worker, trustedTimeRange);
    addToSegmentBudget(budget, decodedBatch);
    decoded.push(decodedBatch);
  }

  return decoded.toSorted(compareDecodedReplayBatches);
}

/**
 * Decode a live-history segment while retaining only one replay tab. The tiny
 * ingest index is read before its compressed payload, so known background tabs
 * do not consume decompression time or browser memory.
 */
export async function decodeReplayHistorySegment(
  segmentBytes: Uint8Array,
  worker: DecodeWorkerHost,
  state: ReplayHistoryDecodeState,
  trustedTimeRange?: Pick<SegmentRef, "t0" | "t1">,
): Promise<DecodedReplayBatch[]> {
  const rawBatches = sliceSegmentBatches(segmentBytes);
  const inspected = rawBatches.map((batch, segmentBatchIndex) => ({
    batch,
    segmentBatchIndex,
    encoded: tryDecodeIndexedBatch(batch),
  }));
  const discoveredTab =
    state.activeTab === undefined ? earliestIndexedCheckpointTab(inspected) : undefined;
  if (discoveredTab !== undefined) {
    selectReplayTab(state, discoveredTab);
  }
  const candidates =
    state.activeTab === undefined && inspected.every((candidate) => candidate.encoded !== undefined)
      ? inspected.toSorted(compareInspectedReplayBatches)
      : inspected;

  const decodedForSegment: DecodedReplayBatch[] = [];
  const segmentBudget = { events: 0, bytes: 0 };
  for (const candidate of candidates) {
    if (
      candidate.encoded !== undefined &&
      state.activeTab !== undefined &&
      candidate.encoded.index.tab !== state.activeTab
    ) {
      continue;
    }

    const decoded = await decodeInspectedBatch(candidate, worker, trustedTimeRange);
    addToSegmentBudget(segmentBudget, decoded);

    if (state.activeTab === undefined) {
      addDiscoveryWork(state, decoded);
      state.batches.push(decoded);
      decodedForSegment.push(decoded);
      if (decoded.events.some((event) => event.type === EventType.FullSnapshot)) {
        selectReplayTab(state, decoded.index.tab);
      }
      continue;
    }

    if (decoded.index.tab !== state.activeTab) {
      addDiscoveryWork(state, decoded);
      continue;
    }

    addActiveReplayBatch(state, decoded);
    state.batches.push(decoded);
    decodedForSegment.push(decoded);
  }

  state.batches.sort(compareDecodedReplayBatches);
  return decodedForSegment.toSorted(compareDecodedReplayBatches);
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

  const checkpointEvents = events.slice(checkpointIndex);
  for (let index = checkpointIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && replayViewportFromEvent(event) !== null) {
      // rrweb keeps its iframe hidden until it receives a viewport event.
      // Keep the latest viewport when rebasing at a full snapshot so the
      // checkpoint can render immediately instead of leaving a black stage.
      return [event, ...checkpointEvents];
    }
  }

  return checkpointEvents;
}

export function validateSegmentCheckpoints(
  segment: SegmentRef,
  batches: readonly DecodedReplayBatch[],
  replayTab?: string,
): void {
  for (const checkpoint of segment.checkpoints ?? []) {
    if (replayTab !== undefined && checkpoint.tab !== replayTab) {
      continue;
    }
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
  trustedTimeRange?: Pick<SegmentRef, "t0" | "t1">,
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
    const decoded = await worker.decodeBatchWithStats(encoded.payload);
    validateReplayEventTimesAgainstIndex(decoded.events, encoded.index);
    return {
      index: encoded.index,
      segmentBatchIndex: batchNumber,
      ...decoded,
    };
  }

  const decoded = await worker.decodeBatchWithStats(batch);
  if (trustedTimeRange !== undefined) {
    validateReplayEventTimesAgainstIndex(decoded.events, trustedTimeRange);
  }
  return {
    decodedBytes: decoded.decodedBytes,
    events: decoded.events,
    index: legacyBatchIndex(decoded.events, batchNumber),
    segmentBatchIndex: batchNumber,
  };
}

interface InspectedSegmentBatch {
  batch: Uint8Array;
  segmentBatchIndex: number;
  encoded?: { index: BatchIndex; payload: Uint8Array };
}

function tryDecodeIndexedBatch(
  batch: Uint8Array,
): { index: BatchIndex; payload: Uint8Array } | undefined {
  try {
    return decodeIngestBody(batch);
  } catch {
    return undefined;
  }
}

async function decodeInspectedBatch(
  inspected: InspectedSegmentBatch,
  worker: DecodeWorkerHost,
  trustedTimeRange?: Pick<SegmentRef, "t0" | "t1">,
): Promise<DecodedReplayBatch> {
  if (inspected.encoded !== undefined) {
    const decoded = await worker.decodeBatchWithStats(inspected.encoded.payload);
    validateReplayEventTimesAgainstIndex(decoded.events, inspected.encoded.index);
    return {
      index: inspected.encoded.index,
      segmentBatchIndex: inspected.segmentBatchIndex,
      ...decoded,
    };
  }

  const decoded = await worker.decodeBatchWithStats(inspected.batch);
  if (trustedTimeRange !== undefined) {
    validateReplayEventTimesAgainstIndex(decoded.events, trustedTimeRange);
  }
  return {
    decodedBytes: decoded.decodedBytes,
    events: decoded.events,
    index: legacyBatchIndex(decoded.events, inspected.segmentBatchIndex),
    segmentBatchIndex: inspected.segmentBatchIndex,
  };
}

function earliestIndexedCheckpointTab(
  batches: readonly InspectedSegmentBatch[],
): string | undefined {
  let first: { tab: string; timestamp: number; batch: number } | undefined;
  for (const candidate of batches) {
    const index = candidate.encoded?.index;
    for (const timestamp of index?.checkpointTimestamps ?? []) {
      if (
        first === undefined ||
        timestamp < first.timestamp ||
        (timestamp === first.timestamp && candidate.segmentBatchIndex < first.batch)
      ) {
        first = { tab: index!.tab, timestamp, batch: candidate.segmentBatchIndex };
      }
    }
  }
  return first?.tab;
}

function selectReplayTab(state: ReplayHistoryDecodeState, activeTab: string): void {
  state.activeTab = activeTab;
  state.batches = state.batches.filter((batch) => batch.index.tab === activeTab);
  state.activeEvents = 0;
  state.activeDecodedBytes = 0;
  state.activeBatches = 0;
  for (const batch of state.batches) {
    addActiveReplayBatch(state, batch);
  }
}

function addActiveReplayBatch(state: ReplayHistoryDecodeState, batch: DecodedReplayBatch): void {
  const nextBatches = state.activeBatches + 1;
  if (nextBatches > MAX_REPLAY_HISTORY_BATCHES) {
    throw new Error("Live replay history has too many batches to load safely.");
  }
  const nextEvents = state.activeEvents + batch.events.length;
  if (nextEvents > MAX_REPLAY_HISTORY_EVENTS) {
    throw new Error("Live replay history has too many events to load safely.");
  }
  const nextBytes = state.activeDecodedBytes + batch.decodedBytes;
  if (nextBytes > MAX_REPLAY_HISTORY_DECODED_BYTES) {
    throw new Error("Live replay history is too large after decoding.");
  }
  state.activeBatches = nextBatches;
  state.activeEvents = nextEvents;
  state.activeDecodedBytes = nextBytes;
}

function addDiscoveryWork(state: ReplayHistoryDecodeState, batch: DecodedReplayBatch): void {
  state.discoveryBatches += 1;
  state.discoveryEvents += batch.events.length;
  state.discoveryDecodedBytes += batch.decodedBytes;
  if (
    state.discoveryBatches > MAX_REPLAY_TAB_DISCOVERY_BATCHES ||
    state.discoveryEvents > MAX_REPLAY_TAB_DISCOVERY_EVENTS ||
    state.discoveryDecodedBytes > MAX_REPLAY_TAB_DISCOVERY_DECODED_BYTES
  ) {
    throw new Error("Live replay history could not find a safe starting snapshot.");
  }
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

function compareInspectedReplayBatches(
  left: InspectedSegmentBatch,
  right: InspectedSegmentBatch,
): number {
  const leftIndex = left.encoded!.index;
  const rightIndex = right.encoded!.index;
  return (
    leftIndex.t0 - rightIndex.t0 ||
    leftIndex.tab.localeCompare(rightIndex.tab) ||
    leftIndex.seq - rightIndex.seq ||
    left.segmentBatchIndex - right.segmentBatchIndex
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
