import type { IndexEvent } from "@orange-replay/shared";
import { parseStoredEvents, type FinalizeEventRow } from "./session-finalize-data.ts";

const encoder = new TextEncoder();
export const ANALYTICS_SIDECAR_PART_BYTES = 5 * 1024 * 1024;

/**
 * Streams one scrubbed sidecar event per line without holding a whole session
 * in Worker memory. Replay payload bytes are not part of these rows.
 */
export function createAnalyticsSidecarStream(
  rows: Iterable<FinalizeEventRow>,
  derivedEvents: readonly IndexEvent[] = [],
): ReadableStream {
  const lines = analyticsSidecarLines(rows, derivedEvents)[Symbol.iterator]();

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = lines.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
    },
    cancel() {
      lines.return?.(undefined);
    },
  });
}

export function analyticsSidecarByteLength(
  rows: Iterable<FinalizeEventRow>,
  derivedEvents: readonly IndexEvent[] = [],
): number {
  let bytes = 0;
  for (const line of analyticsSidecarLines(rows, derivedEvents)) {
    bytes += encoder.encode(line).byteLength;
    if (!Number.isSafeInteger(bytes)) {
      throw new Error("Analytics sidecar is too large.");
    }
  }
  return bytes;
}

/** Builds R2-sized parts without retaining the full session sidecar. */
export function* analyticsSidecarParts(
  rows: Iterable<FinalizeEventRow>,
  derivedEvents: readonly IndexEvent[] = [],
  partBytes = ANALYTICS_SIDECAR_PART_BYTES,
): Generator<Uint8Array> {
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0) {
    throw new Error("Analytics sidecar part size must be a positive whole number.");
  }

  let part = new Uint8Array(partBytes);
  let used = 0;
  for (const line of analyticsSidecarLines(rows, derivedEvents)) {
    const bytes = encoder.encode(line);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const copied = Math.min(part.byteLength - used, bytes.byteLength - offset);
      part.set(bytes.subarray(offset, offset + copied), used);
      used += copied;
      offset += copied;
      if (used === part.byteLength) {
        yield part;
        part = new Uint8Array(partBytes);
        used = 0;
      }
    }
  }

  if (used > 0) yield part.slice(0, used);
}

export function* analyticsSidecarLines(
  rows: Iterable<FinalizeEventRow>,
  derivedEvents: readonly IndexEvent[] = [],
): Generator<string> {
  yield `${JSON.stringify({ v: 1, coverage: "complete" })}\n`;
  let eventIndex = 0;

  for (const row of rows) {
    for (const event of parseStoredEvents(row.events)) {
      // Rage rows are derived from clicks at finalize so there is one shared
      // detector. Ignore any client-provided rage marker and append the
      // trusted derived rows below.
      if (event.k === "rage") continue;
      yield `${JSON.stringify(sidecarEvent(eventIndex, event))}\n`;
      eventIndex += 1;
    }
  }

  for (const event of derivedEvents) {
    yield `${JSON.stringify(sidecarEvent(eventIndex, event))}\n`;
    eventIndex += 1;
  }
}

function sidecarEvent(eventIndex: number, event: IndexEvent): Record<string, unknown> {
  return {
    event_index: eventIndex,
    event_time: event.t,
    event_kind: event.k,
    ...(event.d === undefined ? {} : { event_detail: event.d }),
    ...(event.m === undefined ? {} : { event_meta: event.m }),
  };
}
