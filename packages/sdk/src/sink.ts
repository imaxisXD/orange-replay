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
import { markSdkInternalError } from "./internal-error.ts";
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

interface InFlightBatch {
  seq: number;
  index: BatchIndex;
  rrwebEvents: eventWithTime[];
  eventMetas: EventMeta[];
  indexEvents: IndexEvent[];
  body?: Uint8Array;
  flags?: number;
  finalQueued: boolean;
}

interface SyncFinalBatch {
  body: Uint8Array;
  index: BatchIndex;
  flags: number;
  droppedEventCount: number;
}

export class WorkerSink implements Sink {
  private readonly config: RecorderConfig;
  private readonly session: SessionManager;
  private readonly window: Window;
  private readonly workerHost: WorkerHost;
  private readonly transport: Transport;
  private readonly encoder = new TextEncoder();
  private readonly indexEvents = new IndexEventBuffer();
  private readonly batcher: Batcher;
  private readonly backpressure = new BackpressureController();
  private rrwebEvents: eventWithTime[] = [];
  private eventMetas: EventMeta[] = [];
  private inFlightBatches: InFlightBatch[] = [];
  private currentUrl: string;
  private timerId: number | undefined;
  private stopped = false;
  private flushing: Promise<void> | undefined;
  private warnedAboutInternalError = false;
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
    this.rrwebEvents.push(event);
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
    if (reason === "pagehide") {
      this.clearTimer();
      try {
        this.flushFinalBatchesSync();
      } catch (error) {
        this.disableAfterInternalError(error);
      }
      return this.flushing ?? Promise.resolve();
    }

    if (this.flushing !== undefined) {
      if (reason === "threshold" || reason === "visibility") {
        this.needsFollowUpFlush = true;
      }
      return this.flushing;
    }

    this.clearTimer();
    this.flushing = this.flushNow(reason)
      .catch((error) => {
        this.disableAfterInternalError(error);
      })
      .finally(() => {
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

    await this.flushOne(reason, this.eventMetas.length, indexEvents);
  }

  private async flushOne(
    reason: InternalFlushReason,
    eventCount: number,
    indexEvents: IndexEvent[],
  ): Promise<boolean> {
    const taken = this.batcher.takeBatch(eventCount);
    const rrwebEvents = this.rrwebEvents.splice(0, taken.eventCount);
    const eventMetas = this.eventMetas.splice(0, taken.eventCount);

    if (eventMetas.length === 0 && indexEvents.length === 0) {
      return false;
    }

    this.backpressure.removeCurrentBytes(taken.rawBytes);

    const seq = this.session.nextSeq();
    const index = this.buildIndex(seq, eventMetas, indexEvents);
    const inFlight: InFlightBatch = {
      seq,
      index,
      rrwebEvents,
      eventMetas,
      indexEvents,
      finalQueued: false,
    };
    this.inFlightBatches.push(inFlight);

    try {
      const batch = await this.flushWorkerBatch(taken.eventCount, rrwebEvents, eventMetas);
      this.recordDroppedFromWorker(batch.droppedEventCount, eventMetas.length);
      const flags = batch.uncompressed ? FLAG_UNCOMPRESSED : 0;
      const body = encodeIngestBody(index, batch.payload);
      inFlight.body = body;
      inFlight.flags = flags;

      this.backpressure.addPendingBytes(body.byteLength);
      const result = await this.transport
        .sendBatch({
          body,
          index,
          flags,
          keepalive: false,
        })
        .finally(() => {
          this.backpressure.removePendingBytes(body.byteLength);
        });
      this.batcher.recordCompressedSize(taken.rawBytes, batch.payload.byteLength);

      if (result.dropped) {
        this.backpressure.recordDropped(eventMetas.length);
        return false;
      }

      if (result.ack !== undefined) {
        this.batcher.retuneFromAck(result.ack);

        if (result.ack.drop === true) {
          this.stopAfterServerDrop();
          return true;
        }

        if (result.ack.closed === true) {
          this.session.rotate();
          this.resetPipeline();
          return true;
        }
      }

      return false;
    } finally {
      this.inFlightBatches = this.inFlightBatches.filter((batch) => batch !== inFlight);
    }
  }

  private flushFinalBatchesSync(): void {
    let remainingBytes = this.batcher.getPagehideRawFlushBytes();

    for (const batch of this.inFlightBatches) {
      if (batch.finalQueued) {
        continue;
      }

      if (batch.body !== undefined && batch.body.byteLength <= remainingBytes) {
        const queued = this.queueSyncFinalBatch({
          body: batch.body,
          index: batch.index,
          flags: batch.flags ?? 0,
          droppedEventCount: 0,
        });
        if (queued) {
          remainingBytes -= batch.body.byteLength;
        }
      }

      batch.finalQueued = true;
    }

    const hasCurrentBatch = this.eventMetas.length > 0 || this.indexEvents.count() > 0;
    const currentBatch =
      remainingBytes > 0
        ? this.takeCurrentFinalBatch(remainingBytes)
        : this.dropCurrentFinalBatch();
    if (hasCurrentBatch) {
      this.workerHost.reset();
    }

    if (currentBatch !== null) {
      this.queueSyncFinalBatch(currentBatch);
    }
  }

  private takeCurrentFinalBatch(maxBodyBytes: number): SyncFinalBatch | null {
    const indexEvents = this.indexEvents.drain();
    const taken = this.batcher.takeBatch(this.eventMetas.length);
    const eventMetas = this.eventMetas;
    const rrwebEvents = this.rrwebEvents;

    this.eventMetas = [];
    this.rrwebEvents = [];
    this.backpressure.removeCurrentBytes(taken.rawBytes);

    if (eventMetas.length === 0 && indexEvents.length === 0) {
      return null;
    }

    const seq = this.session.nextSeq();
    const finalBatch = this.buildSyncFinalBatch(
      seq,
      rrwebEvents,
      eventMetas,
      indexEvents,
      maxBodyBytes,
    );
    this.backpressure.recordDropped(finalBatch.droppedEventCount);
    return finalBatch.body === null ? null : finalBatch.body;
  }

  private dropCurrentFinalBatch(): null {
    const droppedCount = this.eventMetas.length;
    const taken = this.batcher.takeBatch(droppedCount);
    this.eventMetas = [];
    this.rrwebEvents = [];
    this.indexEvents.drain();
    this.backpressure.removeCurrentBytes(taken.rawBytes);
    this.backpressure.recordDropped(droppedCount);
    return null;
  }

  private buildSyncFinalBatch(
    seq: number,
    rrwebEvents: readonly eventWithTime[],
    eventMetas: readonly EventMeta[],
    indexEvents: readonly IndexEvent[],
    maxBodyBytes: number,
  ): { body: SyncFinalBatch | null; droppedEventCount: number } {
    if (maxBodyBytes <= 0) {
      return { body: null, droppedEventCount: rrwebEvents.length };
    }

    let keptEventCount = newestEventCountByBytes(eventMetas, maxBodyBytes);
    let keptIndexCount = indexEvents.length;
    let encoded = this.encodeNewestSyncFinalBody(
      seq,
      rrwebEvents,
      eventMetas,
      indexEvents,
      keptEventCount,
      keptIndexCount,
    );

    if (encoded.body.byteLength > maxBodyBytes) {
      keptEventCount = this.findLargestFinalEventCount(
        seq,
        rrwebEvents,
        eventMetas,
        indexEvents,
        keptIndexCount,
        maxBodyBytes,
      );
      encoded = this.encodeNewestSyncFinalBody(
        seq,
        rrwebEvents,
        eventMetas,
        indexEvents,
        keptEventCount,
        keptIndexCount,
      );
    }

    if (encoded.body.byteLength > maxBodyBytes) {
      keptIndexCount = this.findLargestFinalIndexCount(
        seq,
        rrwebEvents,
        eventMetas,
        indexEvents,
        keptEventCount,
        maxBodyBytes,
      );
      encoded = this.encodeNewestSyncFinalBody(
        seq,
        rrwebEvents,
        eventMetas,
        indexEvents,
        keptEventCount,
        keptIndexCount,
      );
    }

    if (encoded.body.byteLength > maxBodyBytes || (keptEventCount === 0 && keptIndexCount === 0)) {
      return { body: null, droppedEventCount: rrwebEvents.length };
    }

    return {
      body: {
        body: encoded.body,
        index: encoded.index,
        flags: FLAG_UNCOMPRESSED,
        droppedEventCount: rrwebEvents.length - keptEventCount,
      },
      droppedEventCount: rrwebEvents.length - keptEventCount,
    };
  }

  private encodeNewestSyncFinalBody(
    seq: number,
    rrwebEvents: readonly eventWithTime[],
    eventMetas: readonly EventMeta[],
    indexEvents: readonly IndexEvent[],
    eventCount: number,
    indexCount: number,
  ): { body: Uint8Array; index: BatchIndex } {
    const eventStart = Math.max(0, rrwebEvents.length - eventCount);
    const indexStart = Math.max(0, indexEvents.length - indexCount);
    const keptEvents = rrwebEvents.slice(eventStart);
    const keptMetas = eventMetas.slice(eventStart);
    const keptIndexEvents = indexEvents.slice(indexStart);
    const index = this.buildIndex(seq, keptMetas, keptIndexEvents);
    const payload = this.encoder.encode(JSON.stringify(keptEvents));
    return { body: encodeIngestBody(index, payload), index };
  }

  private findLargestFinalEventCount(
    seq: number,
    rrwebEvents: readonly eventWithTime[],
    eventMetas: readonly EventMeta[],
    indexEvents: readonly IndexEvent[],
    indexCount: number,
    maxBodyBytes: number,
  ): number {
    let low = 0;
    let high = rrwebEvents.length;
    let best = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const encoded = this.encodeNewestSyncFinalBody(
        seq,
        rrwebEvents,
        eventMetas,
        indexEvents,
        mid,
        indexCount,
      );
      if (encoded.body.byteLength <= maxBodyBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return best;
  }

  private findLargestFinalIndexCount(
    seq: number,
    rrwebEvents: readonly eventWithTime[],
    eventMetas: readonly EventMeta[],
    indexEvents: readonly IndexEvent[],
    eventCount: number,
    maxBodyBytes: number,
  ): number {
    let low = 0;
    let high = indexEvents.length;
    let best = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const encoded = this.encodeNewestSyncFinalBody(
        seq,
        rrwebEvents,
        eventMetas,
        indexEvents,
        eventCount,
        mid,
      );
      if (encoded.body.byteLength <= maxBodyBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return best;
  }

  private queueSyncFinalBatch(batch: SyncFinalBatch): boolean {
    this.backpressure.addPendingBytes(batch.body.byteLength);
    const queued = this.transport.queueBatchSync({
      body: batch.body,
      index: batch.index,
      flags: batch.flags,
      keepalive: true,
    });
    this.backpressure.removePendingBytes(batch.body.byteLength);
    if (!queued) {
      this.backpressure.recordDropped(batch.droppedEventCount);
    }
    return queued;
  }

  private async flushWorkerBatch(
    eventCount: number,
    rrwebEvents: readonly eventWithTime[],
    eventMetas: readonly EventMeta[],
  ) {
    try {
      return await this.workerHost.flushBatch({ eventCount });
    } catch (error) {
      this.workerHost.reset();
      this.workerHost.addEvents(rrwebEvents);

      try {
        return await this.workerHost.flushBatch({ eventCount: rrwebEvents.length });
      } catch (retryError) {
        this.backpressure.recordDropped(eventMetas.length);
        this.workerHost.reset();
        throw markSdkInternalError(retryError || error);
      }
    }
  }

  private recordDroppedFromWorker(
    droppedEventCount: number | undefined,
    totalEventCount: number,
  ): void {
    if (droppedEventCount === undefined || droppedEventCount <= 0) {
      return;
    }

    this.backpressure.recordDropped(Math.min(totalEventCount, Math.floor(droppedEventCount)));
  }

  private resetPipeline(): void {
    this.rrwebEvents = [];
    this.eventMetas = [];
    this.inFlightBatches = [];
    this.indexEvents.drain();
    this.batcher.reset();
    this.backpressure.resetCurrentBytes();
    this.workerHost.reset();
  }

  private stopAfterServerDrop(): void {
    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    this.resetPipeline();
    this.workerHost.stop();
  }

  private disableAfterInternalError(error: unknown): void {
    if (!this.warnedAboutInternalError) {
      this.warnedAboutInternalError = true;
      console.warn(
        "Orange Replay recorder stopped after an internal pipeline error.",
        markSdkInternalError(error),
      );
    }

    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    this.rrwebEvents = [];
    this.eventMetas = [];
    this.inFlightBatches = [];
    this.indexEvents.drain();
    this.batcher.reset();
    this.backpressure.resetCurrentBytes();
    this.workerHost.stop();
  }

  private buildIndex(
    seq: number,
    rrwebEvents: readonly EventMeta[],
    indexEvents: readonly IndexEvent[],
  ): BatchIndex {
    const times = eventTimesFromMeta(rrwebEvents, indexEvents);
    return {
      v: 1,
      s: this.session.sessionId,
      tab: this.session.tabId,
      seq,
      t0: times.t0,
      t1: times.t1,
      e: [...indexEvents],
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
  private warnedAboutInternalError = false;

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
    this.flushing = this.flushNow(reason)
      .catch((error) => {
        this.disableAfterInternalError(error);
      })
      .finally(() => {
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
    if (ack.drop === true) {
      this.stopAfterServerDrop();
      return;
    }

    if (ack.closed === true) {
      this.session.rotate();
    }

    if (Number.isFinite(ack.flushMs) && ack.flushMs > 0) {
      this.flushMs = Math.floor(ack.flushMs);
    }
  }

  private stopAfterServerDrop(): void {
    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    this.rrwebEvents = [];
    this.indexEvents.drain();
  }

  private disableAfterInternalError(error: unknown): void {
    if (!this.warnedAboutInternalError) {
      this.warnedAboutInternalError = true;
      console.warn(
        "Orange Replay recorder stopped after an internal pipeline error.",
        markSdkInternalError(error),
      );
    }

    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    this.rrwebEvents = [];
    this.indexEvents.drain();
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

function newestEventCountByBytes(eventMetas: readonly EventMeta[], maxRawBytes: number): number {
  let rawBytes = 0;
  let count = 0;

  for (let index = eventMetas.length - 1; index >= 0; index -= 1) {
    const meta = eventMetas[index];
    if (meta === undefined) {
      continue;
    }

    if (count > 0 && rawBytes + meta.rawBytes > maxRawBytes) {
      break;
    }

    if (count === 0 && meta.rawBytes > maxRawBytes) {
      break;
    }

    rawBytes += meta.rawBytes;
    count += 1;
  }

  return count;
}
