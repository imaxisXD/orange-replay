export interface ClickPoint {
  timeMs: number;
  x: number;
  y: number;
}

export interface RageBurst extends ClickPoint {
  clickCount: number;
}

export interface RageDetectionOptions {
  windowMs?: number;
  radiusPx?: number;
  minClicks?: number;
}

export const RAGE_CLICK_WINDOW_MS = 600;
export const RAGE_CLICK_RADIUS_PX = 24;
export const RAGE_CLICK_MIN_CLICKS = 3;

export function detectRageClickBursts(
  clicks: readonly ClickPoint[],
  options: RageDetectionOptions = {},
): RageBurst[] {
  const windowMs = cleanNumber(options.windowMs, RAGE_CLICK_WINDOW_MS);
  const radiusPx = cleanNumber(options.radiusPx, RAGE_CLICK_RADIUS_PX);
  const minClicks = Math.max(2, Math.floor(cleanNumber(options.minClicks, RAGE_CLICK_MIN_CLICKS)));
  const sortedClicks = [...clicks].sort((left, right) => left.timeMs - right.timeMs);
  const bursts: RageBurst[] = [];
  let nextAllowedIndex = 0;

  for (let index = 0; index < sortedClicks.length; index += 1) {
    if (index < nextAllowedIndex) {
      continue;
    }

    const first = sortedClicks[index];
    if (first === undefined) {
      continue;
    }

    const matching: ClickPoint[] = [];
    for (let scan = index; scan < sortedClicks.length; scan += 1) {
      const click = sortedClicks[scan];
      if (click === undefined) {
        continue;
      }

      if (click.timeMs - first.timeMs > windowMs) {
        break;
      }

      if (distance(first, click) <= radiusPx) {
        matching.push(click);
      }
    }

    if (matching.length >= minClicks) {
      const last = matching[matching.length - 1] ?? first;
      bursts.push({
        timeMs: last.timeMs,
        x: average(matching.map((click) => click.x)),
        y: average(matching.map((click) => click.y)),
        clickCount: matching.length,
      });
      nextAllowedIndex = index + matching.length;
    }
  }

  return bursts;
}

function distance(left: ClickPoint, right: ClickPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function cleanNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}
