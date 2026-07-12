import { SDK_FLUSH_DEFAULT_MS, SDK_FLUSH_LIVE_MS } from "@orange-replay/shared/constants";
import type { IngestAck } from "@orange-replay/shared/types";
import { estimateEventBytes } from "@orange-replay/rrweb-fork";

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
}

export class Batcher {
  private readonly rawFlushBytes: number;
  private readonly pagehideRawFlushBytes: number;
  private readonly eventRawBytes: number[] = [];
  private totalRawBytes = 0;
  private flushMs: number;

  constructor(options: BatcherOptions = {}) {
    this.flushMs = cleanPositiveNumber(options.flushMs, SDK_FLUSH_DEFAULT_MS);
    this.rawFlushBytes = cleanPositiveNumber(options.rawFlushBytes, BATCH_RAW_FLUSH_BYTES);
    this.pagehideRawFlushBytes = cleanPositiveNumber(
      options.pagehideRawFlushBytes,
      PAGEHIDE_RAW_FLUSH_BYTES,
    );
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

  retuneFromAck(ack: IngestAck): void {
    const nextFlushMs = cleanPositiveNumber(
      ack.live ? Math.min(ack.flushMs, SDK_FLUSH_LIVE_MS) : ack.flushMs,
      ack.live ? SDK_FLUSH_LIVE_MS : SDK_FLUSH_DEFAULT_MS,
    );
    this.flushMs = nextFlushMs;
  }

  takeBatch(eventCount?: number): TakenBatch {
    const take =
      eventCount === undefined
        ? this.eventRawBytes.length
        : Math.max(0, Math.min(this.eventRawBytes.length, Math.floor(eventCount)));
    const bytes = this.eventRawBytes.splice(0, take);
    const rawBytes = sum(bytes);
    this.totalRawBytes -= rawBytes;
    return {
      eventCount: take,
      rawBytes,
    };
  }

  currentRawBytes(): number {
    return this.totalRawBytes;
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
  }
}

export const estimateRrwebEventBytes = estimateEventBytes;

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
