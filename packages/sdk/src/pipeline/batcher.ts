import { SDK_FLUSH_DEFAULT_MS, SDK_FLUSH_LIVE_MS } from "@orange-replay/shared/constants";
import type { IngestAck } from "@orange-replay/shared/types";
import type { eventWithTime } from "@orange-replay/rrweb-fork";

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
    const totalRawBytes = this.currentRawBytes();

    return {
      rawBytes: cleanBytes,
      shouldFlush: totalRawBytes >= this.rawFlushBytes,
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
    this.lastFlushAt = this.now();

    return {
      eventCount: take,
      rawBytes: sum(bytes),
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
    return sum(this.eventRawBytes);
  }

  eventCount(): number {
    return this.eventRawBytes.length;
  }

  getFlushMs(): number {
    return this.flushMs;
  }

  reset(): void {
    this.eventRawBytes.splice(0);
    this.lastFlushAt = this.now();
  }
}

export function estimateRrwebEventBytes(event: eventWithTime): number {
  return estimateJsonBytes(event);
}

export function estimateJsonBytes(value: unknown, depth = 0, seen = new WeakSet<object>()): number {
  if (value === null || value === undefined) {
    return 4;
  }

  if (typeof value === "string") {
    return value.length * 2 + 2;
  }

  if (typeof value === "number") {
    return 16;
  }

  if (typeof value === "boolean") {
    return value ? 4 : 5;
  }

  if (typeof value !== "object") {
    return 8;
  }

  if (seen.has(value)) {
    return 4;
  }

  if (depth > 8) {
    return 64;
  }

  seen.add(value);

  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }

  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }

  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) {
      total += estimateJsonBytes(item, depth + 1, seen) + 1;
    }
    return total;
  }

  let total = 2;
  for (const [key, item] of Object.entries(value)) {
    total += key.length * 2 + 3 + estimateJsonBytes(item, depth + 1, seen);
  }

  return total;
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
