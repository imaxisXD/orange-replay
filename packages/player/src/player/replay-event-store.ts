import { EventType } from "rrweb";
import { retainLiveReplayEvents } from "../live.ts";
import {
  clearReplaySanitizerState,
  createReplaySanitizerState,
  sanitizeReplayEvents,
} from "../sanitize.ts";
import { secureReplayEvents } from "../secure-replayer.ts";
import { eventsFromCheckpoint, mergeReplayEvents, type DecodedReplayBatch } from "../segments.ts";
import type { ReplayEvent } from "../types.ts";

export class ReplayEventStore {
  private readonly sanitizerState = createReplaySanitizerState();
  private storedEvents: ReplayEvent[] = [];
  private activeReplayTab: string | undefined;

  get events(): readonly ReplayEvent[] {
    return this.storedEvents;
  }

  add(events: readonly ReplayEvent[]): ReplayEvent[] {
    if (events.length === 0) {
      return [];
    }

    const sanitizedEvents = secureReplayEvents(sanitizeReplayEvents(events, this.sanitizerState));
    this.append(sanitizedEvents);
    return sanitizedEvents;
  }

  resetEvents(): void {
    this.storedEvents = [];
    clearReplaySanitizerState(this.sanitizerState);
  }

  resetRecordedEvents(activeReplayTab: string | undefined): void {
    this.resetEvents();
    this.activeReplayTab = activeReplayTab;
  }

  rebaseAtCheckpoint(timestamp: number): boolean {
    let retainedEvents: ReplayEvent[];
    try {
      retainedEvents = eventsFromCheckpoint(this.storedEvents, timestamp);
    } catch {
      return false;
    }

    this.storedEvents = retainedEvents;
    clearReplaySanitizerState(this.sanitizerState);
    sanitizeReplayEvents(this.storedEvents, this.sanitizerState);
    return true;
  }

  eventsForRecordedBatches(batches: readonly DecodedReplayBatch[]): ReplayEvent[] {
    this.chooseActiveReplayTab(batches);
    if (this.activeReplayTab === undefined) {
      return [];
    }

    return mergeReplayEvents(
      batches
        .filter((batch) => batch.index.tab === this.activeReplayTab)
        .flatMap((batch) => batch.events),
    );
  }

  acceptsLiveTab(
    tab: string,
    events: readonly ReplayEvent[],
    liveKeyframeStarted: boolean,
  ): boolean {
    if (this.activeReplayTab !== undefined) {
      return this.activeReplayTab === tab;
    }

    if (events.some(isFullSnapshotEvent)) {
      this.activeReplayTab = tab;
      return true;
    }

    if (liveKeyframeStarted) {
      this.activeReplayTab = tab;
      return true;
    }

    return false;
  }

  pruneLiveEvents(cutoffTimestamp: number): void {
    const retainedEvents = retainLiveReplayEvents(this.storedEvents, cutoffTimestamp);
    if (retainedEvents.length === this.storedEvents.length) {
      return;
    }

    this.storedEvents = retainedEvents;
    clearReplaySanitizerState(this.sanitizerState);
    sanitizeReplayEvents(this.storedEvents, this.sanitizerState);
  }

  private chooseActiveReplayTab(batches: readonly DecodedReplayBatch[]): void {
    if (this.activeReplayTab !== undefined) {
      return;
    }

    const snapshotBatch = batches.find((batch) => batch.events.some(isFullSnapshotEvent));
    const firstBatch = snapshotBatch ?? batches.find((batch) => batch.events.length > 0);
    if (firstBatch !== undefined) {
      this.activeReplayTab = firstBatch.index.tab;
    }
  }

  private append(events: readonly ReplayEvent[]): void {
    const orderedEvents = [...events].sort((left, right) => left.timestamp - right.timestamp);
    const lastEvent = this.storedEvents.at(-1);
    const firstNewEvent = orderedEvents[0];

    if (
      lastEvent === undefined ||
      firstNewEvent === undefined ||
      firstNewEvent.timestamp >= lastEvent.timestamp
    ) {
      this.storedEvents.push(...orderedEvents);
      return;
    }

    for (const event of orderedEvents) {
      insertReplayEvent(this.storedEvents, event);
    }
  }
}

function insertReplayEvent(events: ReplayEvent[], event: ReplayEvent): void {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const existing = events[mid];
    if (existing !== undefined && existing.timestamp <= event.timestamp) {
      low = mid + 1;
      continue;
    }

    high = mid;
  }

  events.splice(low, 0, event);
}

function isFullSnapshotEvent(event: ReplayEvent): boolean {
  return event.type === EventType.FullSnapshot;
}
