import type { IndexEvent } from "@orange-replay/shared/types";
import { isSdkInternalError } from "./internal-error.ts";
import type { Sink } from "./sink.ts";
import { buildClickDetail, normalizedCoords, scrubUrl, truncateDetail } from "./scrub.ts";
import type { RecorderConfig } from "./types.ts";

export const MAX_INDEX_EVENTS_PER_BATCH = 200;

type CleanMeta = Record<string, string | number>;

interface QueueRecord {
  k?: unknown;
  t?: unknown;
  m?: unknown;
  d?: unknown;
  n?: unknown;
  u?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  start?: unknown;
  target?: unknown;
}

export class IndexEventBuffer {
  private readonly events: IndexEvent[] = [];
  private dropped = 0;

  add(event: IndexEvent): void {
    if (this.events.length >= MAX_INDEX_EVENTS_PER_BATCH) {
      this.dropped += 1;
      return;
    }

    this.events.push(event);
  }

  drain(): IndexEvent[] {
    const events = this.events.splice(0);
    this.dropped = 0;
    return events;
  }

  count(): number {
    return this.events.length;
  }

  droppedCount(): number {
    return this.dropped;
  }
}

export interface SidecarOptions {
  config: RecorderConfig;
  sink: Sink;
  now: () => number;
  window: Window;
}

export class Sidecar {
  private readonly config: RecorderConfig;
  private readonly sink: Sink;
  private readonly now: () => number;
  private readonly window: Window;
  private readonly removers: Array<() => void> = [];
  private lastScrollAt = 0;
  private originalPushState?: History["pushState"];
  private originalReplaceState?: History["replaceState"];

  constructor(options: SidecarOptions) {
    this.config = options.config;
    this.sink = options.sink;
    this.now = options.now;
    this.window = options.window;
  }

  start(): void {
    this.addDomListener(this.window.document, "click", this.onClick, true);
    this.addDomListener(this.window, "scroll", this.onScroll, true);
    this.addDomListener(this.window, "error", this.onError, true);
    this.addDomListener(this.window, "unhandledrejection", this.onUnhandledRejection, true);
    this.patchHistory();
    this.addDomListener(this.window, "popstate", this.onNavigation, true);
    this.drainPreBuffer();
  }

  stop(): void {
    while (this.removers.length > 0) {
      const remove = this.removers.pop();
      remove?.();
    }

    if (this.originalPushState !== undefined) {
      this.window.history.pushState = this.originalPushState;
      this.originalPushState = undefined;
    }

    if (this.originalReplaceState !== undefined) {
      this.window.history.replaceState = this.originalReplaceState;
      this.originalReplaceState = undefined;
    }
  }

  addCustomEvent(name: string, meta?: Record<string, unknown>): void {
    this.sink.addIndexEvent({
      t: this.now(),
      k: "custom",
      d: truncateDetail(name),
      m: cleanCustomMeta(meta),
    });
  }

  drainPreBuffer(): void {
    const win = this.window as Window & { __orq?: unknown[] };
    const queue = Array.isArray(win.__orq) ? win.__orq.splice(0) : [];

    for (const item of queue) {
      this.addQueuedEvent(item);
    }
  }

  private readonly onClick = (event: Event): void => {
    const mouse = event as MouseEvent;
    const target = this.asElement(mouse.target);
    this.sink.addIndexEvent({
      t: this.now(),
      k: "click",
      d: buildClickDetail(target),
      m: {
        x: normalizedCoords(mouse, this.viewport()).x,
        y: normalizedCoords(mouse, this.viewport()).y,
        w: this.window.innerWidth,
        h: this.window.innerHeight,
      },
    });
  };

  private readonly onScroll = (): void => {
    const nowMs = this.now();
    if (nowMs - this.lastScrollAt < 2_000) {
      return;
    }

    this.lastScrollAt = nowMs;
    this.sink.addIndexEvent({
      t: nowMs,
      k: "scroll",
      m: { depth: this.scrollDepth() },
    });
  };

  private readonly onError = (event: Event): void => {
    const error = event as ErrorEvent;
    if (isSdkInternalError(error.error)) {
      return;
    }

    const message = error.message || stringFromUnknown(error.error) || "error";
    this.sink.addIndexEvent({
      t: this.now(),
      k: "error",
      d: truncateDetail(message),
    });
  };

  private readonly onUnhandledRejection = (event: Event): void => {
    const reason = (event as PromiseRejectionEvent).reason;
    if (isSdkInternalError(reason)) {
      return;
    }

    this.sink.addIndexEvent({
      t: this.now(),
      k: "error",
      d: truncateDetail(stringFromUnknown(reason) || "unhandled rejection"),
    });
  };

  private readonly onNavigation = (): void => {
    this.recordNavigation(this.window.location.href);
  };

  private recordNavigation(url: string): void {
    const scrubbed = scrubUrl(url, this.config.allowUrlParams);
    this.sink.onNavigation(scrubbed);
    this.sink.addIndexEvent({
      t: this.now(),
      k: "nav",
      d: scrubbed,
    });
  }

  private patchHistory(): void {
    const history = this.window.history;
    this.originalPushState = Reflect.get(history, "pushState") as History["pushState"];
    this.originalReplaceState = Reflect.get(history, "replaceState") as History["replaceState"];

    history.pushState = ((...args: Parameters<History["pushState"]>) => {
      const result = this.originalPushState?.apply(history, args);
      this.recordNavigation(String(this.window.location.href));
      return result;
    }) as History["pushState"];

    history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
      const result = this.originalReplaceState?.apply(history, args);
      this.recordNavigation(String(this.window.location.href));
      return result;
    }) as History["replaceState"];
  }

  private addQueuedEvent(item: unknown): void {
    if (!isQueueRecord(item)) {
      return;
    }

    const timestamp = typeof item.t === "number" && Number.isFinite(item.t) ? item.t : this.now();

    if (item.k === "click") {
      const target = this.asElement(item.target);
      const width = cleanNumber(item.w, this.window.innerWidth);
      const height = cleanNumber(item.h, this.window.innerHeight);
      const coords = normalizedCoords(
        {
          clientX: cleanNumber(item.x, 0),
          clientY: cleanNumber(item.y, 0),
        },
        { width, height },
      );
      this.sink.addIndexEvent({
        t: timestamp,
        k: "click",
        d: typeof item.d === "string" ? truncateDetail(item.d) : buildClickDetail(target),
        m: { x: coords.x, y: coords.y, w: width, h: height },
      });
      return;
    }

    if (item.k === "error" || item.k === "unhandledrejection") {
      this.sink.addIndexEvent({
        t: timestamp,
        k: "error",
        d: truncateDetail(stringFromUnknown(item.m) || "error"),
      });
      return;
    }

    if (item.k === "nav" && typeof item.u === "string") {
      this.recordNavigation(item.u);
      return;
    }

    if (item.k === "vital") {
      this.sink.addIndexEvent({
        t: timestamp,
        k: "vital",
        d: typeof item.n === "string" ? truncateDetail(item.n) : "navigation",
        m: { start: cleanNumber(item.start, timestamp) },
      });
    }
  }

  private viewport(): { width: number; height: number } {
    return {
      width: this.window.innerWidth,
      height: this.window.innerHeight,
    };
  }

  private asElement(value: unknown): Element | null {
    const elementCtor = (this.window as Window & typeof globalThis).Element;
    return value instanceof elementCtor ? value : null;
  }

  private scrollDepth(): number {
    const doc = this.window.document.documentElement;
    const body = this.window.document.body;
    const scrollTop = this.window.scrollY || doc.scrollTop || body.scrollTop || 0;
    const viewportHeight = this.window.innerHeight || doc.clientHeight || 0;
    const scrollHeight = Math.max(doc.scrollHeight, body.scrollHeight, viewportHeight);
    const depth = scrollHeight > 0 ? ((scrollTop + viewportHeight) / scrollHeight) * 100 : 0;
    return Math.round(Math.min(100, Math.max(0, depth)) * 100) / 100;
  }

  private addDomListener(
    target: Window | Document,
    type: string,
    listener: EventListener,
    capture = false,
  ): void {
    target.addEventListener(type, listener, capture);
    this.removers.push(() => target.removeEventListener(type, listener, capture));
  }
}

function cleanCustomMeta(meta: Record<string, unknown> | undefined): CleanMeta {
  const output: CleanMeta = {};

  if (meta === undefined) {
    return output;
  }

  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string") {
      output[key] = truncateDetail(value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      output[key] = value;
    }
  }

  return output;
}

function stringFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  if (value === undefined || value === null) {
    return "";
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }

  return "";
}

function cleanNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isQueueRecord(value: unknown): value is QueueRecord {
  return typeof value === "object" && value !== null;
}
