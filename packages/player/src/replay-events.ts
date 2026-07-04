import type { ClickPoint } from "./rage.ts";
import type { ReplayEvent } from "./types.ts";

export interface CursorPoint {
  timeMs: number;
  x: number;
  y: number;
}

export interface ReplayOverlayEvents {
  cursor: CursorPoint[];
  clicks: ClickPoint[];
}

const RRWEB_INCREMENTAL_EVENT = 3;
const RRWEB_MOUSE_MOVE_SOURCE = 1;
const RRWEB_MOUSE_INTERACTION_SOURCE = 2;
const RRWEB_TOUCH_MOVE_SOURCE = 6;
const RRWEB_CLICK_INTERACTION = 2;

export function extractOverlayEvents(
  events: readonly ReplayEvent[],
  startedAt: number,
): ReplayOverlayEvents {
  const cursor: CursorPoint[] = [];
  const clicks: ClickPoint[] = [];

  for (const event of events) {
    if (event.type !== RRWEB_INCREMENTAL_EVENT || !isRecord(event.data)) {
      continue;
    }

    const source = event.data["source"];
    if (source === RRWEB_MOUSE_MOVE_SOURCE || source === RRWEB_TOUCH_MOVE_SOURCE) {
      cursor.push(...readMovePoints(event, startedAt));
      continue;
    }

    if (source === RRWEB_MOUSE_INTERACTION_SOURCE) {
      const click = readClickPoint(event, startedAt);
      if (click !== null) {
        clicks.push(click);
      }
    }
  }

  return {
    cursor: cursor.sort((left, right) => left.timeMs - right.timeMs),
    clicks: clicks.sort((left, right) => left.timeMs - right.timeMs),
  };
}

function readMovePoints(event: ReplayEvent, startedAt: number): CursorPoint[] {
  if (!isRecord(event.data)) {
    return [];
  }

  const positions = event.data["positions"];
  if (!Array.isArray(positions)) {
    return [];
  }

  const points: CursorPoint[] = [];
  for (const item of positions) {
    if (!isRecord(item)) {
      continue;
    }

    const x = readNumber(item["x"]);
    const y = readNumber(item["y"]);
    if (x === null || y === null) {
      continue;
    }

    const timeOffset = readNumber(item["timeOffset"]) ?? 0;
    points.push({
      timeMs: Math.max(0, event.timestamp + timeOffset - startedAt),
      x,
      y,
    });
  }

  return points;
}

function readClickPoint(event: ReplayEvent, startedAt: number): ClickPoint | null {
  if (!isRecord(event.data) || event.data["type"] !== RRWEB_CLICK_INTERACTION) {
    return null;
  }

  const x = readNumber(event.data["x"]);
  const y = readNumber(event.data["y"]);
  if (x === null || y === null) {
    return null;
  }

  return {
    timeMs: Math.max(0, event.timestamp - startedAt),
    x,
    y,
  };
}

function readNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
