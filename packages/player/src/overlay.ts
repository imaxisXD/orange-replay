import {
  detectRageClickBursts,
  RAGE_CLICK_WINDOW_MS,
  type ClickPoint,
  type RageBurst,
} from "./rage.ts";
import { extractOverlayEvents, type CursorPoint } from "./replay-events.ts";
import type { DeadClick } from "./friction.ts";
import type { OverlayOptions, ReplayEvent } from "./types.ts";

interface ResolvedOverlayOptions {
  cursorColor: string;
  cursorOpacity: number;
  clickColor: string;
  clickOpacity: number;
  rageColor: string;
  rageOpacity: number;
  trailMs: number;
}

const defaultOptions: ResolvedOverlayOptions = {
  cursorColor: "oklch(0.784 0.159 72.991)",
  cursorOpacity: 0.95,
  clickColor: "oklch(0.784 0.159 72.991)",
  clickOpacity: 0.7,
  rageColor: "oklch(0.662 0.198 25.892)",
  rageOpacity: 0.78,
  trailMs: 1_800,
};

const TRAIL_OUTLINE_COLOR = "rgb(255 255 255 / 0.95)";
const TRAIL_OUTLINE_WIDTH = 8;
const TRAIL_CORE_WIDTH = 4;

const LIVE_MIN_TRAIL_WINDOW_MS = 2_000;
const LIVE_CLICK_WINDOW_MS = 4_000;
const RAGE_DRAW_WINDOW_MS = 900;
const MAX_CURSOR_POINTS = 20_000;
const MAX_CLICK_POINTS = 10_000;
const MAX_RAGE_BURSTS = 5_000;
const MAX_RAGE_DETECTION_WINDOW_CLICKS = 500;
const MAX_TRAIL_POINTS_PER_FRAME = 120;
const MAX_CLICK_EFFECTS_PER_FRAME = 50;
const MAX_RAGE_EFFECTS_PER_FRAME = 25;
const MAX_DEAD_CLICK_EFFECTS_PER_FRAME = 50;
const CLICK_DRAW_WINDOW_MS = 700;
const DEAD_CLICK_DRAW_WINDOW_MS = 500;
const DEAD_CLICK_MATCH_WINDOW_MS = 150;

export class ReplayOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private resizeObserver: ResizeObserver | undefined;
  private container: HTMLElement;
  private options: ResolvedOverlayOptions;
  private startedAt = 0;
  private currentMs = 0;
  private cursor: CursorPoint[] = [];
  private clicks: ClickPoint[] = [];
  private rageBursts: RageBurst[] = [];
  private deadClickTimes: number[] = [];

  constructor(container: HTMLElement, options: OverlayOptions = {}) {
    this.container = container;
    this.options = resolveOptions(options);
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.zIndex = "3";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.context = this.canvas.getContext("2d");

    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
    }
    this.mount(container);
  }

  mount(container: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.container = container;
    ensurePositioned(container);
    container.append(this.canvas);
    this.resize();
    this.resizeObserver?.observe(container);
  }

  setOptions(options: OverlayOptions): void {
    this.options = resolveOptions(options);
    this.draw(this.currentMs);
  }

  setSessionStart(startedAt: number): void {
    this.startedAt = startedAt;
  }

  setDeadClicks(deadClicks: readonly DeadClick[]): void {
    this.deadClickTimes = [
      ...new Set(deadClicks.map((click) => Math.max(0, click.t - this.startedAt))),
    ].sort((left, right) => left - right);
    this.draw(this.currentMs);
  }

  addEvents(events: readonly ReplayEvent[], options: { liveEdgeMs?: number } = {}): void {
    const extracted = extractOverlayEvents(events, this.startedAt);
    this.cursor = mergePointsByTime(this.cursor, extracted.cursor);
    this.clicks = mergePointsByTime(this.clicks, extracted.clicks);

    if (options.liveEdgeMs !== undefined) {
      this.trimLiveWindow(options.liveEdgeMs);
    }
    this.trimPointLimits();

    this.rageBursts = shouldRunRageDetectionForClicks(this.clicks)
      ? detectRageClickBursts(this.clicks)
      : [];
    this.trimPointLimits();
  }

  bringToFront(): void {
    this.container.append(this.canvas);
    this.resize();
  }

  reset(): void {
    this.cursor = [];
    this.clicks = [];
    this.rageBursts = [];
    this.deadClickTimes = [];
    this.draw(this.currentMs);
  }

  draw(currentMs: number): void {
    this.currentMs = currentMs;
    this.resize();

    const context = this.context;
    if (context === null) {
      return;
    }

    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.save();
    context.scale(deviceScale(), deviceScale());
    this.drawTrail(context, currentMs);
    this.drawClicks(context, currentMs);
    this.drawRageBursts(context, currentMs);
    this.drawDeadClicks(context, currentMs);
    context.restore();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.canvas.remove();
  }

  private resize(): void {
    const scale = deviceScale();
    const width = Math.max(1, Math.floor(this.container.clientWidth * scale));
    const height = Math.max(1, Math.floor(this.container.clientHeight * scale));

    if (this.canvas.width !== width) {
      this.canvas.width = width;
    }
    if (this.canvas.height !== height) {
      this.canvas.height = height;
    }
  }

  private drawTrail(context: CanvasRenderingContext2D, currentMs: number): void {
    const visible = visiblePoints(
      this.cursor,
      currentMs - this.options.trailMs,
      currentMs,
      MAX_TRAIL_POINTS_PER_FRAME,
    );

    if (visible.length === 1) {
      const point = visible[0];
      if (point !== undefined) {
        this.drawTrailMarker(context, point, currentMs);
      }
      return;
    }

    if (visible.length < 2) {
      return;
    }

    context.lineCap = "round";
    context.lineJoin = "round";
    for (let index = 1; index < visible.length; index += 1) {
      const previous = visible[index - 1];
      const next = visible[index];
      if (previous === undefined || next === undefined) {
        continue;
      }

      const age = currentMs - next.timeMs;
      const fade = Math.max(0, 1 - age / this.options.trailMs);
      const alpha = this.options.cursorOpacity * fade;

      context.globalAlpha = alpha * 0.9;
      context.lineWidth = TRAIL_OUTLINE_WIDTH;
      context.strokeStyle = TRAIL_OUTLINE_COLOR;
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(next.x, next.y);
      context.stroke();

      context.globalAlpha = alpha;
      context.lineWidth = TRAIL_CORE_WIDTH;
      context.strokeStyle = this.options.cursorColor;
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(next.x, next.y);
      context.stroke();
    }
  }

  private drawTrailMarker(
    context: CanvasRenderingContext2D,
    point: CursorPoint,
    currentMs: number,
  ): void {
    const age = currentMs - point.timeMs;
    const fade = Math.max(0, 1 - age / this.options.trailMs);
    const alpha = this.options.cursorOpacity * fade;

    context.globalAlpha = alpha * 0.9;
    context.lineWidth = 6;
    context.strokeStyle = TRAIL_OUTLINE_COLOR;
    context.beginPath();
    context.arc(point.x, point.y, 8, 0, Math.PI * 2);
    context.stroke();

    context.globalAlpha = alpha;
    context.lineWidth = 3;
    context.strokeStyle = this.options.cursorColor;
    context.stroke();
  }

  private drawClicks(context: CanvasRenderingContext2D, currentMs: number): void {
    for (const click of visiblePoints(
      this.clicks,
      currentMs - CLICK_DRAW_WINDOW_MS,
      currentMs,
      MAX_CLICK_EFFECTS_PER_FRAME,
    )) {
      const age = currentMs - click.timeMs;
      const progress = age / CLICK_DRAW_WINDOW_MS;
      context.globalAlpha = this.options.clickOpacity * (1 - progress);
      context.strokeStyle = this.options.clickColor;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(click.x, click.y, 8 + progress * 36, 0, Math.PI * 2);
      context.stroke();

      context.globalAlpha = this.options.clickOpacity * 0.5 * (1 - progress);
      context.beginPath();
      context.arc(click.x, click.y, 14 + progress * 38, 0, Math.PI * 2);
      context.stroke();
    }
  }

  private drawRageBursts(context: CanvasRenderingContext2D, currentMs: number): void {
    for (const burst of visiblePoints(
      this.rageBursts,
      currentMs - RAGE_DRAW_WINDOW_MS,
      currentMs,
      MAX_RAGE_EFFECTS_PER_FRAME,
    )) {
      const age = currentMs - burst.timeMs;
      const progress = age / 900;
      context.strokeStyle = this.options.rageColor;
      context.lineWidth = 2.5;

      for (let ring = 0; ring < 3; ring += 1) {
        context.globalAlpha = this.options.rageOpacity * (1 - progress) * (1 - ring * 0.18);
        context.beginPath();
        context.arc(burst.x, burst.y, 10 + progress * 30 + ring * 8, 0, Math.PI * 2);
        context.stroke();
      }
    }
  }

  private drawDeadClicks(context: CanvasRenderingContext2D, currentMs: number): void {
    for (const deadClickTime of visibleTimes(
      this.deadClickTimes,
      currentMs - DEAD_CLICK_DRAW_WINDOW_MS,
      currentMs,
      MAX_DEAD_CLICK_EFFECTS_PER_FRAME,
    )) {
      const age = currentMs - deadClickTime;
      const click = closestClick(this.clicks, deadClickTime);
      if (
        click === undefined ||
        Math.abs(click.timeMs - deadClickTime) > DEAD_CLICK_MATCH_WINDOW_MS
      ) {
        continue;
      }

      const progress = age / DEAD_CLICK_DRAW_WINDOW_MS;
      const arm = 5 + progress * 3;
      context.globalAlpha = 0.9 * (1 - progress);
      context.strokeStyle = "rgb(139 139 149)";
      context.lineWidth = 2.5;
      context.beginPath();
      context.moveTo(click.x - arm, click.y - arm);
      context.lineTo(click.x + arm, click.y + arm);
      context.moveTo(click.x + arm, click.y - arm);
      context.lineTo(click.x - arm, click.y + arm);
      context.stroke();
    }
  }

  private trimLiveWindow(liveEdgeMs: number): void {
    const cleanLiveEdgeMs = Math.max(0, liveEdgeMs);
    const trailWindowMs = Math.max(this.options.trailMs, LIVE_MIN_TRAIL_WINDOW_MS);
    const clickWindowMs = Math.max(
      LIVE_CLICK_WINDOW_MS,
      RAGE_CLICK_WINDOW_MS + RAGE_DRAW_WINDOW_MS,
    );
    const cursorCutoff = Math.max(0, cleanLiveEdgeMs - trailWindowMs);
    const clickCutoff = Math.max(0, cleanLiveEdgeMs - clickWindowMs);

    this.cursor = trimPointsBefore(this.cursor, cursorCutoff);
    this.clicks = trimPointsBefore(this.clicks, clickCutoff);
    this.rageBursts = trimPointsBefore(this.rageBursts, clickCutoff);
  }

  private trimPointLimits(): void {
    this.cursor = trimPointCount(this.cursor, MAX_CURSOR_POINTS);
    this.clicks = trimPointCount(this.clicks, MAX_CLICK_POINTS);
    this.rageBursts = trimPointCount(this.rageBursts, MAX_RAGE_BURSTS);
  }
}

function resolveOptions(options: OverlayOptions): ResolvedOverlayOptions {
  return {
    cursorColor: options.cursorColor ?? defaultOptions.cursorColor,
    cursorOpacity: cleanOpacity(options.cursorOpacity, defaultOptions.cursorOpacity),
    clickColor: options.clickColor ?? defaultOptions.clickColor,
    clickOpacity: cleanOpacity(options.clickOpacity, defaultOptions.clickOpacity),
    rageColor: options.rageColor ?? defaultOptions.rageColor,
    rageOpacity: cleanOpacity(options.rageOpacity, defaultOptions.rageOpacity),
    trailMs: cleanTrailMs(options.trailMs),
  };
}

function mergePointsByTime<T extends { timeMs: number }>(
  left: readonly T[],
  right: readonly T[],
): T[] {
  if (left.length === 0) {
    return [...right];
  }

  if (right.length === 0) {
    return [...left];
  }

  const merged: T[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length || rightIndex < right.length) {
    const leftPoint = left[leftIndex];
    const rightPoint = right[rightIndex];

    if (leftPoint === undefined) {
      if (rightPoint !== undefined) {
        merged.push(rightPoint);
      }
      rightIndex += 1;
      continue;
    }

    if (rightPoint === undefined || leftPoint.timeMs <= rightPoint.timeMs) {
      merged.push(leftPoint);
      leftIndex += 1;
      continue;
    }

    merged.push(rightPoint);
    rightIndex += 1;
  }

  return merged;
}

function trimPointsBefore<T extends { timeMs: number }>(
  points: readonly T[],
  cutoffMs: number,
): T[] {
  const firstKeptIndex = points.findIndex((point) => point.timeMs >= cutoffMs);
  if (firstKeptIndex < 0) {
    return [];
  }

  if (firstKeptIndex === 0) {
    return [...points];
  }

  return points.slice(firstKeptIndex);
}

function trimPointCount<T>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) {
    return [...points];
  }
  return points.slice(points.length - maxPoints);
}

function closestClick(clicks: readonly ClickPoint[], timeMs: number): ClickPoint | undefined {
  let low = 0;
  let high = clicks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const click = clicks[middle];
    if (click !== undefined && click.timeMs < timeMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const next = clicks[low];
  const previous = clicks[low - 1];
  if (previous === undefined) return next;
  if (next === undefined) return previous;
  return timeMs - previous.timeMs <= next.timeMs - timeMs ? previous : next;
}

function visiblePoints<T extends { timeMs: number }>(
  points: readonly T[],
  startMs: number,
  endMs: number,
  limit: number,
): T[] {
  return boundedSortedWindow(points, startMs, endMs, limit, (point) => point.timeMs);
}

function visibleTimes(
  times: readonly number[],
  startMs: number,
  endMs: number,
  limit: number,
): number[] {
  return boundedSortedWindow(times, startMs, endMs, limit, (time) => time);
}

function boundedSortedWindow<T>(
  values: readonly T[],
  startMs: number,
  endMs: number,
  limit: number,
  readTime: (value: T) => number,
): T[] {
  const startIndex = lowerBoundByTime(values, startMs, readTime);
  const endIndex = lowerBoundByTime(values, endMs, readTime, true);
  return values.slice(Math.max(startIndex, endIndex - limit), endIndex);
}

function lowerBoundByTime<T>(
  values: readonly T[],
  targetMs: number,
  readTime: (value: T) => number,
  afterEqual = false,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = values[middle];
    const timeMs = value === undefined ? Number.POSITIVE_INFINITY : readTime(value);
    if (timeMs < targetMs || (afterEqual && timeMs === targetMs)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function shouldRunRageDetectionForClicks(clicks: readonly ClickPoint[]): boolean {
  let windowStart = 0;
  for (let index = 0; index < clicks.length; index += 1) {
    const click = clicks[index];
    if (click === undefined) {
      continue;
    }

    while (
      windowStart < index &&
      click.timeMs - (clicks[windowStart]?.timeMs ?? click.timeMs) > RAGE_CLICK_WINDOW_MS
    ) {
      windowStart += 1;
    }

    if (index - windowStart + 1 > MAX_RAGE_DETECTION_WINDOW_CLICKS) {
      return false;
    }
  }

  return true;
}

function cleanOpacity(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, value));
}

function cleanTrailMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return defaultOptions.trailMs;
  }

  return Math.floor(value);
}

function ensurePositioned(container: HTMLElement): void {
  // Check the COMPUTED position: the host may position the container via
  // classes (e.g. Tailwind absolute inset-0) that inline styles would clobber.
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  if (container.style.overflow.trim().length === 0) {
    container.style.overflow = "hidden";
  }
}

function deviceScale(): number {
  if (typeof window === "undefined" || !Number.isFinite(window.devicePixelRatio)) {
    return 1;
  }

  return Math.max(1, window.devicePixelRatio);
}
