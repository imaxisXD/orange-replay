import {
  batchIndexSchema,
  cleanAnalyticsMetadataString,
  MAX_CHECKPOINTS_PER_BATCH,
  type BatchIndex,
  type IndexEvent,
  type IndexEventKind,
} from "@orange-replay/shared";
import { encoder } from "./hash.ts";

const MAX_EVENTS_PER_BATCH = 200;
const MAX_EVENT_DETAIL_CHARS = 200;
const MAX_EVENT_META_KEYS = 16;
const MAX_EVENT_META_KEY_CHARS = 200;
const MAX_EVENT_META_VALUE_CHARS = 200;
const MAX_EVENT_META_BYTES = 2 * 1024;
const MAX_BATCH_META_BYTES = 16 * 1024;
const MAX_INDEX_URL_CHARS = 2048;
const MAX_INDEX_ENC_KEY_CHARS = 64;
const INDEX_EVENT_KINDS = new Set<IndexEventKind>([
  "click",
  "rage",
  "error",
  "nav",
  "custom",
  "input",
  "scroll",
  "vital",
]);

export function sanitizeBatchIndexEvents(index: BatchIndex): {
  index: BatchIndex;
  eventsDropped: number;
} {
  const events: IndexEvent[] = [];
  let eventsDropped = 0;
  let metaBytesUsed = 0;

  for (const event of index.e as unknown[]) {
    if (events.length >= MAX_EVENTS_PER_BATCH) {
      eventsDropped += 1;
      continue;
    }

    const cleanEvent = sanitizeIndexEvent(event, MAX_BATCH_META_BYTES - metaBytesUsed);
    if (cleanEvent === null) {
      eventsDropped += 1;
      continue;
    }

    metaBytesUsed += cleanEvent.metaBytes;
    events.push(cleanEvent.event);
  }

  const safeCheckpoints = optionalCheckpointTimestamps(
    index.checkpointTimestamps,
    index.t0,
    index.t1,
  );
  const cleanIndex = {
    v: index.v,
    s: index.s,
    tab: index.tab,
    seq: index.seq,
    t0: index.t0,
    t1: index.t1,
    e: events,
    ...safeCheckpoints,
    ...optionalIndexUrl(index.u),
    ...optionalIndexEncoding(index.enc),
  };
  const parsed = batchIndexSchema.safeParse(cleanIndex);

  return {
    index: parsed.success
      ? parsed.data
      : {
          ...index,
          e: events,
          checkpointTimestamps: undefined,
          u: undefined,
          enc: undefined,
          ...safeCheckpoints,
        },
    eventsDropped,
  };
}

function optionalCheckpointTimestamps(
  value: unknown,
  t0: number,
  t1: number,
): { checkpointTimestamps?: number[] } {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CHECKPOINTS_PER_BATCH ||
    value.some(
      (timestamp) =>
        typeof timestamp !== "number" ||
        !Number.isFinite(timestamp) ||
        timestamp < t0 ||
        timestamp > t1,
    )
  ) {
    return {};
  }

  return value.length > 0 ? { checkpointTimestamps: [...value] } : {};
}

function optionalIndexUrl(value: unknown): { u?: string } {
  if (typeof value !== "string" || value.length > MAX_INDEX_URL_CHARS) {
    return {};
  }
  const cleanUrl = scrubAnalyticsUrl(value);
  return cleanUrl === null ? {} : { u: cleanUrl };
}

function optionalIndexEncoding(value: unknown): { enc?: { k: string } } {
  if (!isRecord(value)) {
    return {};
  }
  const key = value["k"];
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_INDEX_ENC_KEY_CHARS) {
    return {};
  }
  return { enc: { k: key } };
}

function scrubAnalyticsUrl(value: string): string | null {
  if (value.startsWith("/") && !value.startsWith("//")) {
    try {
      const url = new URL(value, "https://orange-replay.invalid");
      return url.protocol === "https:" && url.pathname.startsWith("/") ? url.pathname : null;
    } catch {
      return null;
    }
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.pathname : null;
  } catch {
    return null;
  }
}

function sanitizeIndexEvent(
  value: unknown,
  remainingMetaBytes: number,
): { event: IndexEvent; metaBytes: number } | null {
  if (!isRecord(value)) {
    return null;
  }

  const t = value["t"];
  const k = value["k"];
  if (typeof t !== "number" || !Number.isFinite(t)) {
    return null;
  }
  if (typeof k !== "string" || !INDEX_EVENT_KINDS.has(k as IndexEventKind)) {
    return null;
  }

  const event: IndexEvent = { t, k: k as IndexEventKind };
  const detail = value["d"];
  if (typeof detail === "string") {
    if (k === "nav") {
      const cleanUrl = scrubAnalyticsUrl(detail);
      if (cleanUrl !== null) event.d = cleanUrl.slice(0, MAX_EVENT_DETAIL_CHARS);
    } else {
      event.d = detail.slice(0, MAX_EVENT_DETAIL_CHARS);
    }
  }

  const meta = sanitizeEventMeta(value["m"], remainingMetaBytes);
  let metaBytes = 0;
  if (meta !== undefined) {
    event.m = meta.value;
    metaBytes = meta.bytes;
  }

  return { event, metaBytes };
}

function sanitizeEventMeta(
  value: unknown,
  remainingBatchBytes: number,
): { value: Record<string, string | number>; bytes: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (remainingBatchBytes <= 0) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_EVENT_META_KEYS) {
    return undefined;
  }

  const output: Record<string, string | number> = {};
  for (const [key, item] of entries) {
    const cleanKey = key.slice(0, MAX_EVENT_META_KEY_CHARS);
    if (cleanKey.length === 0) {
      continue;
    }

    if (typeof item !== "string" && typeof item !== "number") {
      return undefined;
    }

    let cleanItem: string | number;
    if (typeof item === "string") {
      const cleanUrl = cleanAnalyticsMetadataString(cleanKey, item);
      if (cleanUrl !== item) {
        if (cleanUrl === null) continue;
        cleanItem = cleanUrl.slice(0, MAX_EVENT_META_VALUE_CHARS);
      } else {
        cleanItem = item.slice(0, MAX_EVENT_META_VALUE_CHARS);
      }
    } else if (Number.isFinite(item)) {
      cleanItem = item;
    } else {
      return undefined;
    }

    const next = { ...output, [cleanKey]: cleanItem };
    const nextBytes = encoder.encode(JSON.stringify(next)).byteLength;
    if (nextBytes > MAX_EVENT_META_BYTES || nextBytes > remainingBatchBytes) {
      break;
    }

    output[cleanKey] = cleanItem;
  }

  const bytes = encoder.encode(JSON.stringify(output)).byteLength;
  return Object.keys(output).length > 0 ? { value: output, bytes } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
