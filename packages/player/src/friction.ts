import { EventType, IncrementalSource } from "rrweb";
import type { IndexEvent } from "@orange-replay/shared/types";
import type { ReplayEvent } from "./types.ts";

export const DEAD_CLICK_RESULT_WINDOW_MS = 600;
export const DEAD_CLICK_ERROR_LOOKBACK_MS = 300;

export interface DeadClick {
  t: number;
  detail: string;
}

export interface ActivityBucket {
  index: number;
  count: number;
  intensity: number;
}

export interface DeadClickDetectionOptions {
  minimumClickTimestamp?: number;
}

export function detectDeadClicks(
  events: readonly ReplayEvent[],
  timeline: readonly IndexEvent[],
  options: DeadClickDetectionOptions = {},
): DeadClick[] {
  const orderedEvents = orderedByTimestamp(events, (event) => event.timestamp);
  const orderedTimeline = orderedByTimestamp(timeline, (event) => event.t);
  const observedThrough = latestObservedTime(events);
  const clicks: IndexEvent[] = [];
  const errorTimes: number[] = [];
  const navigationTimes: number[] = [];
  const visibleResultTimes: number[] = [];

  for (const event of orderedTimeline) {
    if (event.k === "click") clicks.push(event);
    if (event.k === "error") errorTimes.push(event.t);
    if (event.k === "nav" || (event.k === "vital" && event.d === "navigation")) {
      navigationTimes.push(event.t);
    }
  }

  for (const event of orderedEvents) {
    if (
      event.type === EventType.Meta ||
      (event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation)
    ) {
      visibleResultTimes.push(event.timestamp);
    }
  }

  const errorCursor = new OrderedTimeRangeCursor(errorTimes);
  const navigationCursor = new OrderedTimeRangeCursor(navigationTimes);
  const visibleResultCursor = new OrderedTimeRangeCursor(visibleResultTimes);
  const deadClicks: DeadClick[] = [];

  for (const click of clicks) {
    if (
      click.t < (options.minimumClickTimestamp ?? Number.NEGATIVE_INFINITY) ||
      isBlockedClick(click) ||
      observedThrough < click.t + DEAD_CLICK_RESULT_WINDOW_MS
    ) {
      continue;
    }

    const resultWindowEnd = click.t + DEAD_CLICK_RESULT_WINDOW_MS;
    if (
      errorCursor.hasTimeInRange(click.t - DEAD_CLICK_ERROR_LOOKBACK_MS, resultWindowEnd) ||
      navigationCursor.hasTimeInRange(click.t, resultWindowEnd) ||
      visibleResultCursor.hasTimeInRange(click.t, resultWindowEnd)
    ) {
      continue;
    }

    deadClicks.push({ t: click.t, detail: clickDetail(click) });
  }

  return deadClicks;
}

export function bucketActivity(
  timeline: readonly IndexEvent[],
  durationMs: number,
  bucketCount = 100,
  startedAt = 0,
): ActivityBucket[] {
  const cleanBucketCount = cleanPositiveInteger(bucketCount, 100);
  const cleanDurationMs = Math.max(0, Math.floor(durationMs));
  const buckets = Array.from({ length: cleanBucketCount }, (_unused, index) => ({
    index,
    count: 0,
    intensity: 0,
  }));

  if (cleanDurationMs === 0) {
    return buckets;
  }

  for (const event of timeline) {
    const offsetMs = clamp(event.t - startedAt, 0, cleanDurationMs);
    const index = Math.min(
      cleanBucketCount - 1,
      Math.floor((offsetMs / cleanDurationMs) * cleanBucketCount),
    );
    const bucket = buckets[index];
    if (bucket !== undefined) {
      bucket.count += 1;
    }
  }

  const maxCount = Math.max(0, ...buckets.map((bucket) => bucket.count));
  if (maxCount === 0) {
    return buckets;
  }

  return buckets.map((bucket) => ({
    ...bucket,
    intensity: bucket.count / maxCount,
  }));
}

function isBlockedClick(event: IndexEvent): boolean {
  if (event.d?.trim() === "[blocked]") {
    return true;
  }

  return ["selector", "target", "path"].some((key) => event.m?.[key] === "[blocked]");
}

function clickDetail(event: IndexEvent): string {
  for (const key of ["selector", "target", "path"]) {
    const value = event.m?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return event.d?.trim() || "Unknown element";
}

function latestObservedTime(events: readonly ReplayEvent[]): number {
  let latest = 0;
  for (const event of events) {
    latest = Math.max(latest, event.timestamp);
  }
  return latest;
}

class OrderedTimeRangeCursor {
  private index = 0;

  constructor(private readonly times: readonly number[]) {}

  hasTimeInRange(startExclusive: number, endInclusive: number): boolean {
    while (
      this.index < this.times.length &&
      (this.times[this.index] ?? Infinity) <= startExclusive
    ) {
      this.index += 1;
    }
    const next = this.times[this.index];
    return next !== undefined && next <= endInclusive;
  }
}

function orderedByTimestamp<T>(
  values: readonly T[],
  readTimestamp: (value: T) => number,
): readonly T[] {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      readTimestamp(previous) > readTimestamp(current)
    ) {
      return [...values].sort((left, right) => readTimestamp(left) - readTimestamp(right));
    }
  }
  return values;
}

function cleanPositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
