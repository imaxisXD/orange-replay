import { MAX_CHECKPOINTS_PER_BATCH } from "@orange-replay/shared/constants";
import type { BatchIndex, IndexEvent } from "@orange-replay/shared/types";
import type { SessionManager } from "../session.ts";

export interface EventMeta {
  timestamp: number;
  rawBytes: number;
  fullSnapshot?: boolean;
  requiredSnapshot?: boolean;
  pagehideRequiredOversized?: boolean;
  pagehideEstimateUnknown?: boolean;
}

interface TimestampedEvent {
  timestamp: number;
  fullSnapshot?: boolean;
}

interface BatchIndexOptions {
  session: SessionManager;
  seq: number;
  currentUrl: string;
  rrwebEvents: readonly TimestampedEvent[];
  indexEvents: readonly IndexEvent[];
}

export function buildBatchIndex(options: BatchIndexOptions): BatchIndex {
  const times = eventTimes(options.rrwebEvents, options.indexEvents);
  const checkpointTimestamps = Array.from(
    new Set(
      options.rrwebEvents
        .filter((event) => event.fullSnapshot === true)
        .map((event) => event.timestamp),
    ),
  )
    .toSorted((left, right) => left - right)
    .slice(0, MAX_CHECKPOINTS_PER_BATCH);
  return {
    v: 1,
    s: options.session.sessionId,
    tab: options.session.tabId,
    seq: options.seq,
    t0: times.t0,
    t1: times.t1,
    e: [...options.indexEvents],
    ...(checkpointTimestamps.length > 0 ? { checkpointTimestamps } : {}),
    u: options.currentUrl,
  };
}

function eventTimes(
  rrwebEvents: readonly TimestampedEvent[],
  indexEvents: readonly IndexEvent[],
): { t0: number; t1: number } {
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = 0;

  for (const event of rrwebEvents) {
    t0 = Math.min(t0, event.timestamp);
    t1 = Math.max(t1, event.timestamp);
  }

  for (const event of indexEvents) {
    t0 = Math.min(t0, event.t);
    t1 = Math.max(t1, event.t);
  }

  if (t0 === Number.POSITIVE_INFINITY) {
    return { t0: Date.now(), t1: Date.now() };
  }

  return { t0, t1 };
}
