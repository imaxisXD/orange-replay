import {
  FLAG_UNCOMPRESSED,
  HDR_FLAGS,
  HDR_KEY,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  SDK_FLUSH_DEFAULT_MS,
} from "@orange-replay/shared/constants";
import type { BatchIndex, IndexEvent, IngestAck } from "@orange-replay/shared/types";
import { encodeIngestBody } from "@orange-replay/shared/wire";
import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { scrubUrl } from "./scrub.ts";
import type { SessionManager } from "./session.ts";
import { IndexEventBuffer } from "./sidecar.ts";
import type { RecorderConfig } from "./types.ts";

export interface Sink {
  addRrwebEvent(event: eventWithTime): void;
  addIndexEvent(event: IndexEvent): void;
  onNavigation(url: string): void;
  flush(reason: "timer" | "visibility" | "pagehide" | "manual"): Promise<void>;
  stop(): Promise<void>;
}

export interface InlineSinkOptions {
  config: RecorderConfig;
  session: SessionManager;
  window: Window;
  fetch?: typeof fetch;
}

export class InlineSink implements Sink {
  private readonly config: RecorderConfig;
  private readonly session: SessionManager;
  private readonly window: Window;
  private readonly fetchFn: typeof fetch;
  private readonly encoder = new TextEncoder();
  private readonly indexEvents = new IndexEventBuffer();
  private rrwebEvents: eventWithTime[] = [];
  private currentUrl: string;
  private flushMs: number;
  private timerId: number | undefined;
  private stopped = false;
  private flushing: Promise<void> | undefined;

  constructor(options: InlineSinkOptions) {
    this.config = options.config;
    this.session = options.session;
    this.window = options.window;
    this.fetchFn = options.fetch ?? options.window.fetch.bind(options.window);
    this.currentUrl = scrubUrl(options.window.location.href, options.config.allowUrlParams);
    this.flushMs = options.config.flushMs || SDK_FLUSH_DEFAULT_MS;
  }

  start(): void {
    this.scheduleTimer();
    this.window.document.addEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.addEventListener("pagehide", this.onPageHide, true);
  }

  addRrwebEvent(event: eventWithTime): void {
    if (this.stopped) {
      return;
    }

    this.rrwebEvents.push(event);
  }

  addIndexEvent(event: IndexEvent): void {
    if (this.stopped) {
      return;
    }

    this.indexEvents.add(event);
  }

  onNavigation(url: string): void {
    this.currentUrl = scrubUrl(url, this.config.allowUrlParams);
  }

  flush(reason: "timer" | "visibility" | "pagehide" | "manual"): Promise<void> {
    if (this.flushing !== undefined) {
      return this.flushing;
    }

    this.clearTimer();
    this.flushing = this.flushNow(reason).finally(() => {
      this.flushing = undefined;
      if (!this.stopped) {
        this.scheduleTimer();
      }
    });

    return this.flushing;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    await this.flush("manual");
  }

  getFlushMs(): number {
    return this.flushMs;
  }

  droppedIndexEventCount(): number {
    return this.indexEvents.droppedCount();
  }

  private async flushNow(reason: "timer" | "visibility" | "pagehide" | "manual"): Promise<void> {
    const rrwebEvents = this.rrwebEvents;
    const indexEvents = this.indexEvents.drain();
    this.rrwebEvents = [];

    if (rrwebEvents.length === 0 && indexEvents.length === 0) {
      return;
    }

    const seq = this.session.nextSeq();
    const index = this.buildIndex(seq, rrwebEvents, indexEvents);
    const payload = this.encoder.encode(JSON.stringify(rrwebEvents));
    const body = encodeIngestBody(index, payload);
    const response = await this.fetchFn(`${this.config.ingestUrl}/v1/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        [HDR_KEY]: this.config.key,
        [HDR_SESSION]: index.s,
        [HDR_TAB]: index.tab,
        [HDR_SEQ]: String(index.seq),
        [HDR_FLAGS]: String(FLAG_UNCOMPRESSED),
      },
      body: body as unknown as BodyInit,
      keepalive: reason === "pagehide",
    });

    const ack = await readAck(response);
    if (ack.closed === true) {
      this.session.rotate();
    }

    if (Number.isFinite(ack.flushMs) && ack.flushMs > 0) {
      this.flushMs = Math.floor(ack.flushMs);
    }
  }

  private buildIndex(
    seq: number,
    rrwebEvents: eventWithTime[],
    indexEvents: IndexEvent[],
  ): BatchIndex {
    const times = eventTimes(rrwebEvents, indexEvents);
    return {
      v: 1,
      s: this.session.sessionId,
      tab: this.session.tabId,
      seq,
      t0: times.t0,
      t1: times.t1,
      e: indexEvents,
      u: this.currentUrl,
    };
  }

  private scheduleTimer(): void {
    this.clearTimer();
    this.timerId = this.window.setTimeout(() => {
      void this.flush("timer");
    }, this.flushMs);
  }

  private clearTimer(): void {
    if (this.timerId !== undefined) {
      this.window.clearTimeout(this.timerId);
      this.timerId = undefined;
    }
  }

  private readonly onVisibilityChange = (): void => {
    if (this.window.document.visibilityState === "hidden") {
      void this.flush("visibility");
    }
  };

  private readonly onPageHide = (): void => {
    void this.flush("pagehide");
  };
}

async function readAck(response: Response): Promise<IngestAck> {
  try {
    const parsed = (await response.json()) as Partial<IngestAck>;
    return {
      ok: parsed.ok === true,
      live: parsed.live === true,
      flushMs:
        typeof parsed.flushMs === "number" && Number.isFinite(parsed.flushMs)
          ? parsed.flushMs
          : SDK_FLUSH_DEFAULT_MS,
      drop: parsed.drop === true,
      closed: parsed.closed === true,
    };
  } catch {
    return { ok: false, live: false, flushMs: SDK_FLUSH_DEFAULT_MS };
  }
}

function eventTimes(
  rrwebEvents: readonly eventWithTime[],
  indexEvents: readonly IndexEvent[],
): {
  t0: number;
  t1: number;
} {
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = 0;

  for (const event of rrwebEvents) {
    t0 = Math.min(t0, event.timestamp);
    t1 = Math.max(t1, event.timestamp);
  }

  for (const event of indexEvents) {
    t0 = Math.min(t0, event.t);
    t1 = Math.max(t1, event.t);
  }

  if (t0 === Number.POSITIVE_INFINITY) {
    return { t0: Date.now(), t1: Date.now() };
  }

  return { t0, t1 };
}
