import type { IndexEvent } from "@orange-replay/shared/types";
import { DEFAULT_INACTIVITY_GAP_MS } from "@orange-replay/shared/insights";
import type {
  InactivityGap,
  PlayerTimeline,
  TimelineMarker,
  TimelineMarkerKind,
  TimelineTick,
} from "./types.ts";

export { DEFAULT_INACTIVITY_GAP_MS } from "@orange-replay/shared/insights";
const DEFAULT_TICK_COUNT = 120;

const markerKinds = new Set<TimelineMarkerKind>(["click", "rage", "error", "nav", "custom"]);
const activityKinds = new Set<IndexEvent["k"]>([
  "click",
  "rage",
  "input",
  "scroll",
  "nav",
  "custom",
]);

export interface BuildTimelineOptions {
  startedAt: number;
  durationMs: number;
  tickCount?: number;
}

export interface InactivityOptions {
  startedAt: number;
  durationMs: number;
  thresholdMs?: number;
}

export interface SkipResult {
  timeMs: number;
  skipped: boolean;
}

export function buildTimeline(
  events: readonly IndexEvent[],
  options: BuildTimelineOptions,
): PlayerTimeline {
  const durationMs = Math.max(0, Math.floor(options.durationMs));
  const tickCount = cleanTickCount(options.tickCount);
  const ticks = buildTicks(events, options.startedAt, durationMs, tickCount);
  const markers = buildMarkers(events, options.startedAt, durationMs);

  return {
    durationMs,
    ticks,
    markers,
    counts: {
      clicks: countKind(events, "click"),
      deadClicks: 0,
      errors: countKind(events, "error"),
      rages: countKind(events, "rage"),
      navs: countKind(events, "nav"),
      customs: countKind(events, "custom"),
    },
    deadClicks: [],
    sourceEvents: [...events].sort(compareIndexEvents),
  };
}

export function findInactivityGaps(
  events: readonly IndexEvent[],
  options: InactivityOptions,
): InactivityGap[] {
  const thresholdMs = cleanThreshold(options.thresholdMs);
  const durationMs = Math.max(0, options.durationMs);
  const activityTimes = events
    .filter((event) => activityKinds.has(event.k))
    .map((event) => clampTime(event.t - options.startedAt, durationMs))
    .toSorted((left, right) => left - right);
  const gaps: InactivityGap[] = [];

  for (let index = 1; index < activityTimes.length; index += 1) {
    const startMs = activityTimes[index - 1];
    const endMs = activityTimes[index];
    if (startMs === undefined || endMs === undefined) {
      continue;
    }

    const duration = endMs - startMs;
    if (duration > thresholdMs) {
      gaps.push({ startMs, endMs, durationMs: duration });
    }
  }

  return gaps;
}

export function applySkipInactivity(
  currentMs: number,
  nextMs: number,
  gaps: readonly InactivityGap[],
): SkipResult {
  let timeMs = Math.max(currentMs, nextMs);
  let skipped = false;

  for (const gap of gaps) {
    if (currentMs <= gap.startMs && timeMs > gap.startMs && timeMs < gap.endMs) {
      timeMs = gap.endMs;
      skipped = true;
      continue;
    }

    if (currentMs > gap.startMs && currentMs < gap.endMs && timeMs < gap.endMs) {
      timeMs = gap.endMs;
      skipped = true;
    }
  }

  return { timeMs, skipped };
}

function buildTicks(
  events: readonly IndexEvent[],
  startedAt: number,
  durationMs: number,
  tickCount: number,
): TimelineTick[] {
  const ticks = Array.from({ length: tickCount }, (_unused, index) => ({
    timeMs: tickTime(index, durationMs, tickCount),
    count: 0,
  }));

  if (durationMs === 0) {
    return ticks;
  }

  for (const event of events) {
    const timeMs = clampTime(event.t - startedAt, durationMs);
    const index = Math.min(ticks.length - 1, Math.floor((timeMs / durationMs) * ticks.length));
    const tick = ticks[index];
    if (tick !== undefined) {
      tick.count += 1;
    }
  }

  return ticks;
}

function buildMarkers(
  events: readonly IndexEvent[],
  startedAt: number,
  durationMs: number,
): TimelineMarker[] {
  const markers: TimelineMarker[] = [];

  for (const event of events) {
    if (!markerKinds.has(event.k as TimelineMarkerKind)) {
      continue;
    }

    markers.push({
      timeMs: clampTime(event.t - startedAt, durationMs),
      kind: event.k as TimelineMarkerKind,
      label: event.d,
      meta: event.m,
    });
  }

  return markers.sort((left, right) => left.timeMs - right.timeMs);
}

function tickTime(index: number, durationMs: number, tickCount: number): number {
  if (tickCount <= 1) {
    return 0;
  }

  return Math.round((durationMs * index) / (tickCount - 1));
}

function cleanTickCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_TICK_COUNT;
  }

  return Math.max(1, Math.floor(value));
}

function cleanThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_INACTIVITY_GAP_MS;
  }

  return Math.floor(value);
}

function countKind(events: readonly IndexEvent[], kind: IndexEvent["k"]): number {
  return events.reduce((total, event) => total + (event.k === kind ? 1 : 0), 0);
}

function compareIndexEvents(left: IndexEvent, right: IndexEvent): number {
  return left.t - right.t;
}

function clampTime(value: number, durationMs: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(durationMs, Math.max(0, Math.floor(value)));
}
