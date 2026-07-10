import { detectRageClickBursts, MAX_RAGE_DETECTION_CLICKS, type ClickPoint } from "./rage.ts";
import type { IndexEvent } from "./types.ts";

export const DEFAULT_INACTIVITY_GAP_MS = 5_000;
export const QUICK_BACK_MAX_DWELL_MS = 10_000;
// Keeps finalize sorting small while covering more than thirteen hours at one interaction per second.
export const MAX_INTERACTION_TIMESTAMPS = 50_000;

const interactionEventKinds = new Set<IndexEvent["k"]>([
  "click",
  "rage",
  "input",
  "scroll",
  "nav",
  "custom",
]);

export interface TimelineInsights {
  rageEvents: IndexEvent[];
  maxScrollDepth: number;
  interactionTimeMs: number;
}

export function deriveTimelineInsights(events: readonly IndexEvent[]): TimelineInsights {
  const accumulator = new TimelineInsightsAccumulator();
  for (const event of events) {
    accumulator.add(event);
  }
  return accumulator.finish();
}

/** Collects only bounded inputs so finalize can stream batches without retaining the session. */
export class TimelineInsightsAccumulator {
  private readonly clicks: ClickPoint[] = [];
  private readonly interactionTimes: number[] = [];
  private maxScrollDepth = 0;

  add(event: IndexEvent): void {
    const click = clickPoint(event);
    if (click !== null && this.clicks.length < MAX_RAGE_DETECTION_CLICKS) {
      this.clicks.push(click);
    }

    if (event.k === "scroll") {
      const depth = finiteNumber(event.m?.["depth"]);
      if (depth !== null) {
        this.maxScrollDepth = Math.max(this.maxScrollDepth, Math.min(100, Math.max(0, depth)));
      }
    }

    if (
      interactionEventKinds.has(event.k) &&
      Number.isFinite(event.t) &&
      this.interactionTimes.length < MAX_INTERACTION_TIMESTAMPS
    ) {
      this.interactionTimes.push(event.t);
    }
  }

  finish(): TimelineInsights {
    return {
      rageEvents: rageEventsFromClicks(this.clicks),
      maxScrollDepth: Math.round(this.maxScrollDepth),
      interactionTimeMs: interactionTimeFromTimes(this.interactionTimes, DEFAULT_INACTIVITY_GAP_MS),
    };
  }
}

export function deriveRageEvents(events: readonly IndexEvent[]): IndexEvent[] {
  const clicks: ClickPoint[] = [];
  for (const event of events) {
    const click = clickPoint(event);
    if (click !== null) {
      clicks.push(click);
      if (clicks.length >= MAX_RAGE_DETECTION_CLICKS) break;
    }
  }
  return rageEventsFromClicks(clicks);
}

function rageEventsFromClicks(clicks: readonly ClickPoint[]): IndexEvent[] {
  return detectRageClickBursts(clicks).map((burst) => ({
    t: burst.timeMs,
    k: "rage",
    d: "Rage click burst",
    m: { x: burst.x, y: burst.y, clicks: burst.clickCount },
  }));
}

function clickPoint(event: IndexEvent): ClickPoint | null {
  if (event.k !== "click") return null;

  const x = normalizedNumber(event.m?.["x"]);
  const y = normalizedNumber(event.m?.["y"]);
  const width = positiveNumber(event.m?.["w"]);
  const height = positiveNumber(event.m?.["h"]);
  if (x === null || y === null || width === null || height === null) return null;

  return { timeMs: event.t, x: x * width, y: y * height };
}

export function deriveMaxScrollDepth(events: readonly IndexEvent[]): number {
  let maxDepth = 0;

  for (const event of events) {
    if (event.k !== "scroll") {
      continue;
    }

    const depth = finiteNumber(event.m?.["depth"]);
    if (depth !== null) {
      maxDepth = Math.max(maxDepth, Math.min(100, Math.max(0, depth)));
    }
  }

  return Math.round(maxDepth);
}

export function deriveInteractionTimeMs(
  events: readonly IndexEvent[],
  inactivityGapMs = DEFAULT_INACTIVITY_GAP_MS,
): number {
  const gapLimit = positiveNumber(inactivityGapMs) ?? DEFAULT_INACTIVITY_GAP_MS;
  return interactionTimeFromTimes(
    events
      .filter((event) => interactionEventKinds.has(event.k) && Number.isFinite(event.t))
      .map((event) => event.t),
    gapLimit,
  );
}

function interactionTimeFromTimes(eventTimes: readonly number[], gapLimit: number): number {
  const sortedEventTimes = eventTimes.toSorted((left, right) => left - right);
  let interactionTimeMs = 0;

  for (let index = 1; index < sortedEventTimes.length; index += 1) {
    const previous = sortedEventTimes[index - 1];
    const current = sortedEventTimes[index];
    if (previous === undefined || current === undefined) {
      continue;
    }

    interactionTimeMs += Math.min(gapLimit, Math.max(0, current - previous));
  }

  return Math.round(interactionTimeMs);
}

function normalizedNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
