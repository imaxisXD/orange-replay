import { ActivityHistAccumulator, TimelineInsightsAccumulator } from "@orange-replay/shared";
import type { IndexEvent, SessionCounts, TimelineInsights } from "@orange-replay/shared";
import {
  filterFinalizeEvents,
  MAX_MANIFEST_TIMELINE_BYTES,
  MAX_MANIFEST_TIMELINE_EVENTS,
} from "./session-budgets.ts";
import { parseStoredSidecarEvents } from "./session-batch-metadata.ts";

export interface FinalizeEventRow {
  events: string;
}

export interface FinalizeTimelineData {
  timeline: IndexEvent[];
  finalizeEvents: IndexEvent[];
  insights: TimelineInsights;
  activityHist: string | null;
  counts: Omit<SessionCounts, "batches">;
}

interface TimelineCandidateBucket {
  events: IndexEvent[];
  bytes: number;
}

const utf8Encoder = new TextEncoder();

export function buildFinalizeTimelineData(
  rows: Iterable<FinalizeEventRow>,
  startedAt: number,
  endedAt: number,
): FinalizeTimelineData {
  const insights = new TimelineInsightsAccumulator();
  const activityHist = new ActivityHistAccumulator(startedAt, endedAt);
  const notable: TimelineCandidateBucket = { events: [], bytes: 2 };
  const ordinary: TimelineCandidateBucket = { events: [], bytes: 2 };
  const errorEvents: IndexEvent[] = [];
  const customEvents: IndexEvent[] = [];
  let sourceEvents = 0;
  let clicks = 0;
  let errors = 0;
  let navs = 0;

  for (const row of rows) {
    const batchEvents = parseStoredEvents(row.events).toSorted((left, right) => left.t - right.t);
    for (const event of batchEvents) {
      insights.add(event);
      activityHist.add(event.t, event.k);

      if (event.k === "error" && errorEvents.length < 200) errorEvents.push(event);
      if (event.k === "custom" && customEvents.length < 200) customEvents.push(event);
      if (event.k === "rage") continue;

      sourceEvents += 1;
      if (event.k === "click") clicks += 1;
      if (event.k === "error") errors += 1;
      if (event.k === "nav") navs += 1;
      addTimelineCandidate(isNotableEvent(event) ? notable : ordinary, event);
    }
  }

  const derived = insights.finish();
  for (const rageEvent of derived.rageEvents) addTimelineCandidate(notable, rageEvent);

  return {
    timeline: [...notable.events, ...ordinary.events].toSorted((left, right) => left.t - right.t),
    finalizeEvents: filterFinalizeEvents([...errorEvents, ...customEvents]),
    insights: derived,
    activityHist: activityHist.finish(),
    counts: {
      events: sourceEvents + derived.rageEvents.length,
      clicks,
      errors,
      rages: derived.rageEvents.length,
      navs,
    },
  };
}

export function parseStoredEvents(raw: string): IndexEvent[] {
  return parseStoredSidecarEvents(raw);
}

function addTimelineCandidate(bucket: TimelineCandidateBucket, event: IndexEvent): void {
  if (bucket.events.length >= MAX_MANIFEST_TIMELINE_EVENTS) return;

  const eventBytes = utf8Encoder.encode(JSON.stringify(event)).byteLength;
  const nextBytes = bucket.bytes + eventBytes + (bucket.events.length === 0 ? 0 : 1);
  if (nextBytes > MAX_MANIFEST_TIMELINE_BYTES) return;

  bucket.events.push(event);
  bucket.bytes = nextBytes;
}

function isNotableEvent(event: IndexEvent): boolean {
  return (
    event.k === "error" ||
    event.k === "rage" ||
    event.k === "nav" ||
    (event.k === "vital" && event.d === "navigation" && typeof event.m?.["url"] === "string")
  );
}
