import { EventType, IncrementalSource } from "rrweb";
import type { ReplayEvent } from "./types.ts";

export interface ReplayViewport {
  width: number;
  height: number;
}

export interface StageSize {
  width: number;
  height: number;
}

export interface ReplayFit {
  scale: number;
  width: number;
  height: number;
  left: number;
  top: number;
}

export interface ReplayPoint {
  x: number;
  y: number;
}

export function cleanReplayViewport(width: unknown, height: unknown): ReplayViewport | null {
  if (!isPositiveNumber(width) || !isPositiveNumber(height)) {
    return null;
  }

  return {
    width,
    height,
  };
}

export function replayViewportFromEvent(event: ReplayEvent): ReplayViewport | null {
  if (event.type === EventType.Meta) {
    return cleanReplayViewport(event.data.width, event.data.height);
  }

  if (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.ViewportResize
  ) {
    return cleanReplayViewport(event.data.width, event.data.height);
  }

  return null;
}

export function replayViewportAt(
  events: readonly ReplayEvent[],
  timestamp: number,
): ReplayViewport | null {
  let firstViewport: ReplayViewport | null = null;
  let currentViewport: ReplayViewport | null = null;

  for (const event of events) {
    const viewport = replayViewportFromEvent(event);
    if (viewport === null) {
      continue;
    }

    firstViewport ??= viewport;
    if (event.timestamp <= timestamp) {
      currentViewport = viewport;
    }
  }

  return currentViewport ?? firstViewport;
}

export function fitReplayToStage(stage: StageSize, viewport: ReplayViewport): ReplayFit {
  const stageWidth = positiveOrZero(stage.width);
  const stageHeight = positiveOrZero(stage.height);
  const scale =
    stageWidth > 0 && stageHeight > 0
      ? Math.min(stageWidth / viewport.width, stageHeight / viewport.height)
      : 1;
  const width = viewport.width * scale;
  const height = viewport.height * scale;

  return {
    scale,
    width,
    height,
    left: Math.max(0, (stageWidth - width) / 2),
    top: Math.max(0, (stageHeight - height) / 2),
  };
}

export function mapReplayPointToStage(point: ReplayPoint, fit: ReplayFit): ReplayPoint {
  return {
    x: fit.left + point.x * fit.scale,
    y: fit.top + point.y * fit.scale,
  };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveOrZero(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return value;
}
