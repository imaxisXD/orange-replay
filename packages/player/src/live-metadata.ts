import { deriveRageEvents } from "@orange-replay/shared/insights";
import type { BatchIndex, IndexEvent, LiveSessionSnapshot } from "@orange-replay/shared/types";

const MAX_LIVE_TIMELINE_EVENTS = 10_000;

export function applyLiveIndexToSnapshot(
  snapshot: LiveSessionSnapshot,
  index: BatchIndex,
): LiveSessionSnapshot {
  const incomingEvents = index.e.filter((event) => event.k !== "rage");
  const sourceTimeline = snapshot.timeline.filter((event) => event.k !== "rage");
  const nextSourceTimeline = [...sourceTimeline, ...incomingEvents].toSorted(
    (left, right) => left.t - right.t,
  );
  const derivedRageEvents = deriveRageEvents(nextSourceTimeline);
  const nextRageCount = Math.max(snapshot.counts.rages, derivedRageEvents.length);
  const addedRageCount = nextRageCount - snapshot.counts.rages;
  const timeline = [...nextSourceTimeline, ...derivedRageEvents]
    .toSorted((left, right) => left.t - right.t)
    .slice(-MAX_LIVE_TIMELINE_EVENTS);
  const endedAt = Math.max(snapshot.endedAt, index.t1, latestEventTime(incomingEvents));

  return {
    ...snapshot,
    endedAt,
    durationMs: Math.max(snapshot.durationMs, endedAt - snapshot.startedAt),
    timeline,
    counts: {
      batches: snapshot.counts.batches + 1,
      events: snapshot.counts.events + incomingEvents.length + addedRageCount,
      clicks: snapshot.counts.clicks + countEvents(incomingEvents, "click"),
      errors: snapshot.counts.errors + countEvents(incomingEvents, "error"),
      rages: nextRageCount,
      navs: snapshot.counts.navs + countEvents(incomingEvents, "nav"),
    },
  };
}

function countEvents(events: readonly IndexEvent[], kind: IndexEvent["k"]): number {
  let count = 0;
  for (const event of events) {
    if (event.k === kind) count += 1;
  }
  return count;
}

function latestEventTime(events: readonly IndexEvent[]): number {
  let latest = 0;
  for (const event of events) latest = Math.max(latest, event.t);
  return latest;
}
