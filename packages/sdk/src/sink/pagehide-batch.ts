import { FLAG_UNCOMPRESSED, REPLAY_DATA_LIMITS } from "@orange-replay/shared/constants";
import { countReplayValues } from "@orange-replay/shared/replay-limits";
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
  containsRequiredSnapshot: boolean;
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
  appliedDomMasking?: BatchIndex["appliedDomMasking"];
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
    keptEventCount = findLargestEventCount(options, keptIndexCount, keptEventCount);
    encoded = encodeNewestPagehideBody(options, keptEventCount, keptIndexCount);
  }

  if (encoded.body.byteLength > options.maxBodyBytes) {
    keptIndexCount = findLargestIndexCount(options, keptEventCount);
    encoded = encodeNewestPagehideBody(options, keptEventCount, keptIndexCount);
  }

  if (
    encoded.body.byteLength > options.maxBodyBytes ||
    (keptEventCount === 0 && keptIndexCount === 0) ||
    dropsRequiredBaseline(options.eventMetas, keptEventCount)
  ) {
    return { batch: null, droppedEventCount: options.rrwebEvents.length };
  }

  // Byte size alone does not bound nesting or object complexity. Validate the
  // final selection once, after the byte search, before sending it on pagehide.
  try {
    if (keptEventCount > REPLAY_DATA_LIMITS.events) throw new Error("Too many replay events.");
    let values = 0;
    for (
      let index = options.rrwebEvents.length - keptEventCount;
      index < options.rrwebEvents.length;
      index += 1
    ) {
      values += countReplayValues(
        options.rrwebEvents[index],
        0,
        REPLAY_DATA_LIMITS.values - values,
      );
    }
  } catch {
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
      containsRequiredSnapshot: options.eventMetas
        .slice(options.eventMetas.length - keptEventCount)
        .some((event) => event.requiredSnapshot === true),
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
    appliedDomMasking: options.appliedDomMasking,
  });
  const payload = options.encoder.encode(JSON.stringify(keptEvents));
  return { body: encodeIngestBody(index, payload), index };
}

function findLargestEventCount(
  options: PagehideBatchOptions,
  indexCount: number,
  failedEventCount: number,
): number {
  let low = 0;
  // This count was already encoded and did not fit. Only smaller counts can
  // help; larger counts would repeat work on events excluded by the estimate.
  let high = failedEventCount - 1;
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
  for (let index = eventMetas.length - 1; index >= 0; index -= 1) {
    const event = eventMetas[index]!;
    if (event.requiredSnapshot !== true) continue;
    if (event.pagehideRequiredOversized === true) return 0;
    break;
  }
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
      // Do not synchronously stringify a known oversized optional event while
      // the page is closing. Required baselines are handled above.
      if (meta.pagehideEstimateUnknown === true) count = 1;
      break;
    }

    rawBytes += meta.rawBytes;
    count += 1;
  }

  return count;
}

function dropsRequiredBaseline(eventMetas: readonly EventMeta[], keptEventCount: number): boolean {
  const keptStart = eventMetas.length - keptEventCount;
  for (let index = eventMetas.length - 1; index >= 0; index -= 1) {
    if (eventMetas[index]?.requiredSnapshot === true) return keptStart > index;
  }
  return false;
}
