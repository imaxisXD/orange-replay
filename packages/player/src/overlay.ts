import { detectRageClickBursts, type ClickPoint, type RageBurst } from "./rage.ts";
import { extractOverlayEvents, type CursorPoint } from "./replay-events.ts";
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
  cursorColor: "#f5a623",
  cursorOpacity: 0.75,
  clickColor: "#f5a623",
  clickOpacity: 0.7,
  rageColor: "#f4534e",
  rageOpacity: 0.78,
  trailMs: 1_000,
};

export class ReplayOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver | undefined;
  private options: ResolvedOverlayOptions;
  private startedAt = 0;
  private currentMs = 0;
  private cursor: CursorPoint[] = [];
  private clicks: ClickPoint[] = [];
  private rageBursts: RageBurst[] = [];

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

    ensurePositioned(container);
    container.append(this.canvas);
    this.resize();

    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
  }

  setOptions(options: OverlayOptions): void {
    this.options = resolveOptions(options);
    this.draw(this.currentMs);
  }

  setSessionStart(startedAt: number): void {
    this.startedAt = startedAt;
  }

  addEvents(events: readonly ReplayEvent[]): void {
    const extracted = extractOverlayEvents(events, this.startedAt);
    this.cursor = mergePoints(this.cursor, extracted.cursor);
    this.clicks = mergePoints(this.clicks, extracted.clicks);
    this.rageBursts = detectRageClickBursts(this.clicks);
  }

  bringToFront(): void {
    this.container.append(this.canvas);
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
    const visible = this.cursor.filter(
      (point) => point.timeMs <= currentMs && currentMs - point.timeMs <= this.options.trailMs,
    );

    if (visible.length < 2) {
      return;
    }

    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 2.5;
    context.strokeStyle = this.options.cursorColor;

    for (let index = 1; index < visible.length; index += 1) {
      const previous = visible[index - 1];
      const next = visible[index];
      if (previous === undefined || next === undefined) {
        continue;
      }

      const age = currentMs - next.timeMs;
      context.globalAlpha = this.options.cursorOpacity * (1 - age / this.options.trailMs);
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(next.x, next.y);
      context.stroke();
    }
  }

  private drawClicks(context: CanvasRenderingContext2D, currentMs: number): void {
    for (const click of this.clicks) {
      const age = currentMs - click.timeMs;
      if (age < 0 || age > 650) {
        continue;
      }

      const progress = age / 650;
      context.globalAlpha = this.options.clickOpacity * (1 - progress);
      context.strokeStyle = this.options.clickColor;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(click.x, click.y, 8 + progress * 24, 0, Math.PI * 2);
      context.stroke();
    }
  }

  private drawRageBursts(context: CanvasRenderingContext2D, currentMs: number): void {
    for (const burst of this.rageBursts) {
      const age = currentMs - burst.timeMs;
      if (age < 0 || age > 900) {
        continue;
      }

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

function mergePoints<T extends { timeMs: number }>(left: readonly T[], right: readonly T[]): T[] {
  return [...left, ...right].sort((a, b) => a.timeMs - b.timeMs);
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
  if (container.style.position.trim().length === 0) {
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
