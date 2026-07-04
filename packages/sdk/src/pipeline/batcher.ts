import { SDK_FLUSH_DEFAULT_MS, SDK_FLUSH_LIVE_MS } from "@orange-replay/shared/constants";
import type { IngestAck } from "@orange-replay/shared/types";
import { EventType, IncrementalSource, type eventWithTime } from "@orange-replay/rrweb-fork";

export const BATCH_RAW_FLUSH_BYTES = 128 * 1024;
export const PAGEHIDE_RAW_FLUSH_BYTES = 60 * 1024;

export interface BatchDecision {
  shouldFlush: boolean;
  rawBytes: number;
}

export interface TakenBatch {
  eventCount: number;
  rawBytes: number;
}

export interface PagehideTakenBatch extends TakenBatch {
  startIndex: number;
  droppedCount: number;
  droppedRawBytes: number;
  totalRawBytes: number;
}

export interface BatcherOptions {
  flushMs?: number;
  rawFlushBytes?: number;
  pagehideRawFlushBytes?: number;
  now?: () => number;
}

export class Batcher {
  private readonly rawFlushBytes: number;
  private readonly pagehideRawFlushBytes: number;
  private readonly now: () => number;
  private readonly eventRawBytes: number[] = [];
  private totalRawBytes = 0;
  private flushMs: number;
  private lastFlushAt: number;
  private compressionRatio = 1;

  constructor(options: BatcherOptions = {}) {
    this.flushMs = cleanPositiveNumber(options.flushMs, SDK_FLUSH_DEFAULT_MS);
    this.rawFlushBytes = cleanPositiveNumber(options.rawFlushBytes, BATCH_RAW_FLUSH_BYTES);
    this.pagehideRawFlushBytes = cleanPositiveNumber(
      options.pagehideRawFlushBytes,
      PAGEHIDE_RAW_FLUSH_BYTES,
    );
    this.now = options.now ?? Date.now;
    this.lastFlushAt = this.now();
  }

  addEvent(event: eventWithTime): BatchDecision {
    return this.addEstimatedBytes(estimateRrwebEventBytes(event));
  }

  addEstimatedBytes(rawBytes: number): BatchDecision {
    const cleanBytes = Math.max(0, Math.floor(rawBytes));
    this.eventRawBytes.push(cleanBytes);
    this.totalRawBytes += cleanBytes;

    return {
      rawBytes: cleanBytes,
      shouldFlush: this.totalRawBytes >= this.rawFlushBytes,
    };
  }

  shouldTimerFlush(): boolean {
    return this.now() - this.lastFlushAt >= this.flushMs;
  }

  retuneFromAck(ack: IngestAck): void {
    const nextFlushMs = cleanPositiveNumber(
      ack.live ? Math.min(ack.flushMs, SDK_FLUSH_LIVE_MS) : ack.flushMs,
      ack.live ? SDK_FLUSH_LIVE_MS : SDK_FLUSH_DEFAULT_MS,
    );
    this.flushMs = nextFlushMs;
  }

  pagehideChunkCounts(): number[] {
    if (this.eventRawBytes.length === 0) {
      return [];
    }

    const chunks: number[] = [];
    let currentBytes = 0;
    let currentCount = 0;

    for (const bytes of this.eventRawBytes) {
      if (currentCount > 0 && currentBytes + bytes > this.pagehideRawFlushBytes) {
        chunks.push(currentCount);
        currentBytes = 0;
        currentCount = 0;
      }

      currentBytes += bytes;
      currentCount += 1;
    }

    if (currentCount > 0) {
      chunks.push(currentCount);
    }

    return chunks;
  }

  takeBatch(eventCount?: number): TakenBatch {
    const take =
      eventCount === undefined
        ? this.eventRawBytes.length
        : Math.max(0, Math.min(this.eventRawBytes.length, Math.floor(eventCount)));
    const bytes = this.eventRawBytes.splice(0, take);
    const rawBytes = sum(bytes);
    this.totalRawBytes -= rawBytes;
    this.lastFlushAt = this.now();

    return {
      eventCount: take,
      rawBytes,
    };
  }

  takeNewestPagehideBatch(): PagehideTakenBatch {
    const totalRawBytes = this.totalRawBytes;
    let startIndex = this.eventRawBytes.length;
    let rawBytes = 0;

    for (let index = this.eventRawBytes.length - 1; index >= 0; index -= 1) {
      const bytes = this.eventRawBytes[index] ?? 0;
      if (rawBytes + bytes > this.pagehideRawFlushBytes) {
        break;
      }

      rawBytes += bytes;
      startIndex = index;
    }

    const droppedBytes = this.eventRawBytes.slice(0, startIndex);
    const eventCount = this.eventRawBytes.length - startIndex;
    this.eventRawBytes.splice(0);
    this.totalRawBytes = 0;
    this.lastFlushAt = this.now();

    return {
      startIndex,
      eventCount,
      rawBytes,
      droppedCount: startIndex,
      droppedRawBytes: sum(droppedBytes),
      totalRawBytes,
    };
  }

  recordCompressedSize(rawBytes: number, compressedBytes: number): void {
    if (rawBytes <= 0 || compressedBytes <= 0) {
      return;
    }

    const nextRatio = Math.min(1, compressedBytes / rawBytes);
    this.compressionRatio = this.compressionRatio * 0.7 + nextRatio * 0.3;
  }

  estimatedCompressedBytes(): number {
    return Math.ceil(this.currentRawBytes() * this.compressionRatio);
  }

  currentRawBytes(): number {
    return this.totalRawBytes;
  }

  eventCount(): number {
    return this.eventRawBytes.length;
  }

  getFlushMs(): number {
    return this.flushMs;
  }

  getPagehideRawFlushBytes(): number {
    return this.pagehideRawFlushBytes;
  }

  reset(): void {
    this.eventRawBytes.splice(0);
    this.totalRawBytes = 0;
    this.lastFlushAt = this.now();
  }
}

export function estimateRrwebEventBytes(event: eventWithTime): number {
  if (event.type === EventType.FullSnapshot) {
    return 16 * 1024;
  }

  if (event.type !== EventType.IncrementalSnapshot) {
    return 512;
  }

  switch (event.data.source) {
    case IncrementalSource.Mutation:
      return 4 * 1024;
    case IncrementalSource.MouseMove:
    case IncrementalSource.TouchMove:
    case IncrementalSource.Drag:
      return 256;
    case IncrementalSource.Scroll:
    case IncrementalSource.MouseInteraction:
    case IncrementalSource.Input:
      return 512;
    default:
      return 1024;
  }
}

function cleanPositiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
