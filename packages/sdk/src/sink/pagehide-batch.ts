import { FLAG_UNCOMPRESSED } from "@orange-replay/shared/constants";
import type { BatchIndex, IndexEvent } from "@orange-replay/shared/types";
import { encodeIngestBody } from "@orange-replay/shared/wire";
import type { eventWithTime } from "@orange-replay/rrweb-fork";
import type { SessionManager } from "../session.ts";
import { buildBatchIndex, type EventMeta } from "./batch-index.ts";

export interface PagehideBatch {
  body: Uint8Array;
  index: BatchIndex;
  flags: number;
  queuedEventCount: number;
  droppedEventCount: number;
}

interface PagehideBatchOptions {
  encoder: TextEncoder;
  session: SessionManager;
  currentUrl: string;
  seq: number;
  rrwebEvents: readonly eventWithTime[];
  eventMetas: readonly EventMeta[];
  indexEvents: readonly IndexEvent[];
  maxBodyBytes: number;
}

export function buildPagehideBatch(options: PagehideBatchOptions): {
  batch: PagehideBatch | null;
  droppedEventCount: number;
} {
  if (options.maxBodyBytes <= 0) {
    return { batch: null, droppedEventCount: options.rrwebEvents.length };
  }

  let keptEventCount = newestEventCountByBytes(options.eventMetas, options.maxBodyBytes);
  let keptIndexCount = options.indexEvents.length;
  let encoded = encodeNewestPagehideBody(options, keptEventCount, keptIndexCount);

  if (encoded.body.byteLength > options.maxBodyBytes) {
    keptEventCount = findLargestEventCount(options, keptIndexCount);
    encoded = encodeNewestPagehideBody(options, keptEventCount, keptIndexCount);
  }

  if (encoded.body.byteLength > options.maxBodyBytes) {
    keptIndexCount = findLargestIndexCount(options, keptEventCount);
    encoded = encodeNewestPagehideBody(options, keptEventCount, keptIndexCount);
  }

  if (
    encoded.body.byteLength > options.maxBodyBytes ||
    (keptEventCount === 0 && keptIndexCount === 0)
  ) {
    return { batch: null, droppedEventCount: options.rrwebEvents.length };
  }

  const droppedEventCount = options.rrwebEvents.length - keptEventCount;
  return {
    batch: {
      body: encoded.body,
      index: encoded.index,
      flags: FLAG_UNCOMPRESSED,
      queuedEventCount: keptEventCount,
      droppedEventCount,
    },
    droppedEventCount,
  };
}

function encodeNewestPagehideBody(
  options: PagehideBatchOptions,
  eventCount: number,
  indexCount: number,
): { body: Uint8Array; index: BatchIndex } {
  const eventStart = Math.max(0, options.rrwebEvents.length - eventCount);
  const indexStart = Math.max(0, options.indexEvents.length - indexCount);
  const keptEvents = options.rrwebEvents.slice(eventStart);
  const keptMetas = options.eventMetas.slice(eventStart);
  const keptIndexEvents = options.indexEvents.slice(indexStart);
  const index = buildBatchIndex({
    session: options.session,
    seq: options.seq,
    currentUrl: options.currentUrl,
    rrwebEvents: keptMetas,
    indexEvents: keptIndexEvents,
  });
  const payload = options.encoder.encode(JSON.stringify(keptEvents));
  return { body: encodeIngestBody(index, payload), index };
}

function findLargestEventCount(options: PagehideBatchOptions, indexCount: number): number {
  let low = 0;
  let high = options.rrwebEvents.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const encoded = encodeNewestPagehideBody(options, mid, indexCount);
    if (encoded.body.byteLength <= options.maxBodyBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function findLargestIndexCount(options: PagehideBatchOptions, eventCount: number): number {
  let low = 0;
  let high = options.indexEvents.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const encoded = encodeNewestPagehideBody(options, eventCount, mid);
    if (encoded.body.byteLength <= options.maxBodyBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function newestEventCountByBytes(eventMetas: readonly EventMeta[], maxRawBytes: number): number {
  let rawBytes = 0;
  let count = 0;

  for (let index = eventMetas.length - 1; index >= 0; index -= 1) {
    const meta = eventMetas[index];
    if (meta === undefined) {
      continue;
    }

    if (count > 0 && rawBytes + meta.rawBytes > maxRawBytes) {
      break;
    }

    if (count === 0 && meta.rawBytes > maxRawBytes) {
      break;
    }

    rawBytes += meta.rawBytes;
    count += 1;
  }

  return count;
}
