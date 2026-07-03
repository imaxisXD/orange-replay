import {
  FLAG_UNCOMPRESSED,
  HDR_FLAGS,
  HDR_KEY,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  SDK_FLUSH_DEFAULT_MS,
} from "@orange-replay/shared/constants";
import type { BatchIndex, IndexEvent } from "@orange-replay/shared/types";
import { encodeIngestBody } from "@orange-replay/shared/wire";
import type { eventWithTime } from "@orange-replay/rrweb-fork";
import { BackpressureController } from "./pipeline/backpressure.ts";
import { BATCH_RAW_FLUSH_BYTES, Batcher, estimateRrwebEventBytes } from "./pipeline/batcher.ts";
import { readAck, Transport } from "./pipeline/transport.ts";
import { WorkerHost } from "./pipeline/worker-host.ts";
import { scrubUrl } from "./scrub.ts";
import type { SessionManager } from "./session.ts";
import { IndexEventBuffer } from "./sidecar.ts";
import type { RecorderConfig } from "./types.ts";

export type FlushReason = "timer" | "visibility" | "pagehide" | "manual";
type InternalFlushReason = FlushReason | "threshold";

export interface Sink {
  addRrwebEvent(event: eventWithTime): void;
  addIndexEvent(event: IndexEvent): void;
  onNavigation(url: string): void;
  flush(reason: FlushReason): Promise<void>;
  stop(): Promise<void>;
}

export interface InlineSinkOptions {
  config: RecorderConfig;
  session: SessionManager;
  window: Window;
  fetch?: typeof fetch;
}

export interface WorkerSinkOptions extends InlineSinkOptions {
  workerHost?: WorkerHost;
  transport?: Transport;
}

interface EventMeta {
  timestamp: number;
  rawBytes: number;
}

export class WorkerSink implements Sink {
  private readonly config: RecorderConfig;
  private readonly session: SessionManager;
  private readonly window: Window;
  private readonly workerHost: WorkerHost;
  private readonly transport: Transport;
  private readonly indexEvents = new IndexEventBuffer();
  private readonly batcher: Batcher;
  private readonly backpressure = new BackpressureController();
  private eventMetas: EventMeta[] = [];
  private currentUrl: string;
  private timerId: number | undefined;
  private stopped = false;
  private flushing: Promise<void> | undefined;
  private needsFollowUpFlush = false;

  constructor(options: WorkerSinkOptions) {
    this.config = options.config;
    this.session = options.session;
    this.window = options.window;
    this.currentUrl = scrubUrl(options.window.location.href, options.config.allowUrlParams);
    this.batcher = new Batcher({ flushMs: options.config.flushMs || SDK_FLUSH_DEFAULT_MS });
    this.workerHost =
      options.workerHost ??
      new WorkerHost({
        warn(message) {
          console.warn(message);
        },
      });
    this.transport =
      options.transport ??
      new Transport({
        config: options.config,
        fetch: options.fetch ?? options.window.fetch.bind(options.window),
        navigator: options.window.navigator,
      });
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

    const rawBytes = estimateRrwebEventBytes(event);
    const pressure = this.backpressure.canAccept(event, rawBytes);
    if (!pressure.accept) {
      return;
    }

    const decision = this.batcher.addEstimatedBytes(rawBytes);
    this.eventMetas.push({ timestamp: event.timestamp, rawBytes });
    this.backpressure.addCurrentBytes(rawBytes);
    this.workerHost.addEvents([event]);

    if (decision.shouldFlush) {
      void this.flushInternal("threshold");
    }
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

  flush(reason: FlushReason): Promise<void> {
    return this.flushInternal(reason);
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    await this.flushInternal("manual");
    this.workerHost.stop();
  }

  getFlushMs(): number {
    return this.batcher.getFlushMs();
  }

  droppedEventCount(): number {
    return this.backpressure.droppedCount() + this.indexEvents.droppedCount();
  }

  private flushInternal(reason: InternalFlushReason): Promise<void> {
    if (this.flushing !== undefined) {
      if (reason === "threshold" || reason === "pagehide") {
        this.needsFollowUpFlush = true;
      }
      return this.flushing;
    }

    this.clearTimer();
    this.flushing = this.flushNow(reason).finally(() => {
      const shouldFlushAgain =
        !this.stopped &&
        (this.needsFollowUpFlush || this.batcher.currentRawBytes() > 0) &&
        this.batcher.currentRawBytes() >= BATCH_RAW_FLUSH_BYTES;

      this.needsFollowUpFlush = false;
      this.flushing = undefined;

      if (shouldFlushAgain) {
        void this.flushInternal("threshold");
        return;
      }

      if (!this.stopped) {
        this.scheduleTimer();
      }
    });

    return this.flushing;
  }

  private async flushNow(reason: InternalFlushReason): Promise<void> {
    const indexEvents = this.indexEvents.drain();
    if (this.eventMetas.length === 0 && indexEvents.length === 0) {
      return;
    }

    if (reason === "pagehide") {
      const chunks = this.batcher.pagehideChunkCounts();
      if (chunks.length === 0) {
        await this.flushOne(reason, 0, indexEvents);
        return;
      }

      let first = true;
      for (const count of chunks) {
        const closed = await this.flushOne(reason, count, first ? indexEvents : []);
        first = false;
        if (closed) {
          return;
        }
      }
      return;
    }

    await this.flushOne(reason, this.eventMetas.length, indexEvents);
  }

  private async flushOne(
    reason: InternalFlushReason,
    eventCount: number,
    indexEvents: IndexEvent[],
  ): Promise<boolean> {
    const taken = this.batcher.takeBatch(eventCount);
    const eventMetas = this.eventMetas.splice(0, taken.eventCount);

    if (eventMetas.length === 0 && indexEvents.length === 0) {
      return false;
    }

    this.backpressure.removeCurrentBytes(taken.rawBytes);

    const seq = this.session.nextSeq();
    const index = this.buildIndex(seq, eventMetas, indexEvents);
    const batch = await this.workerHost.flushBatch({ eventCount: taken.eventCount });
    const flags = batch.uncompressed ? FLAG_UNCOMPRESSED : 0;
    const body = encodeIngestBody(index, batch.payload);

    this.backpressure.addPendingBytes(body.byteLength);
    const result = await this.transport.sendBatch({
      body,
      index,
      flags,
      keepalive: reason === "pagehide",
    });
    this.backpressure.removePendingBytes(body.byteLength);
    this.batcher.recordCompressedSize(taken.rawBytes, batch.payload.byteLength);

    if (result.ack !== undefined) {
      this.batcher.retuneFromAck(result.ack);

      if (result.ack.closed === true) {
        this.session.rotate();
        this.resetPipeline();
        return true;
      }
    }

    return false;
  }

  private resetPipeline(): void {
    this.eventMetas = [];
    this.indexEvents.drain();
    this.batcher.reset();
    this.backpressure.resetCurrentBytes();
    this.workerHost.reset();
  }

  private buildIndex(seq: number, rrwebEvents: EventMeta[], indexEvents: IndexEvent[]): BatchIndex {
    const times = eventTimesFromMeta(rrwebEvents, indexEvents);
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
      void this.flushInternal("timer");
    }, this.batcher.getFlushMs());
  }

  private clearTimer(): void {
    if (this.timerId !== undefined) {
      this.window.clearTimeout(this.timerId);
      this.timerId = undefined;
    }
  }

  private readonly onVisibilityChange = (): void => {
    if (this.window.document.visibilityState === "hidden") {
      void this.flushInternal("visibility");
    }
  };

  private readonly onPageHide = (): void => {
    void this.flushInternal("pagehide");
  };
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

  flush(reason: FlushReason): Promise<void> {
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

  private async flushNow(reason: FlushReason): Promise<void> {
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

function eventTimesFromMeta(
  rrwebEvents: readonly EventMeta[],
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
