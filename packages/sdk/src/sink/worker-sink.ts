import { FLAG_UNCOMPRESSED, SDK_FLUSH_DEFAULT_MS } from "@orange-replay/shared/constants";
import type { BatchIndex, IndexEvent } from "@orange-replay/shared/types";
import { encodeIngestBody } from "@orange-replay/shared/wire";
import { EventType, type eventWithTime } from "@orange-replay/rrweb-fork";
import { markSdkInternalError } from "../internal-error.ts";
import { BackpressureController } from "../pipeline/backpressure.ts";
import { BATCH_RAW_FLUSH_BYTES, Batcher, estimateRrwebEventBytes } from "../pipeline/batcher.ts";
import { Transport } from "../pipeline/transport.ts";
import { WorkerHost } from "../pipeline/worker-host.ts";
import { scrubUrl } from "../scrub.ts";
import type { SessionManager } from "../session.ts";
import { IndexEventBuffer } from "../sidecar.ts";
import type { RecorderConfig } from "../types.ts";
import type { FlushReason, InternalFlushReason, Sink, WorkerSinkOptions } from "./contracts.ts";
import { buildBatchIndex, type EventMeta } from "./batch-index.ts";
import { buildPagehideBatch, type PagehideBatch } from "./pagehide-batch.ts";

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

export class WorkerSink implements Sink {
  private readonly config: RecorderConfig;
  private readonly session: SessionManager;
  private readonly window: Window;
  private readonly workerHost: WorkerHost;
  private readonly transport: Transport;
  private readonly onSessionClosed?: () => void;
  private readonly onCheckpointRequested?: () => void;
  private readonly encoder = new TextEncoder();
  private readonly indexEvents = new IndexEventBuffer();
  private readonly batcher: Batcher;
  private readonly backpressure = new BackpressureController();
  private rrwebEvents: eventWithTime[] = [];
  private pendingWorkerEvents: eventWithTime[] = [];
  private eventMetas: EventMeta[] = [];
  private inFlightBatches: InFlightBatch[] = [];
  private currentUrl: string;
  private timerId: number | undefined;
  private stopped = false;
  private flushing: Promise<void> | undefined;
  private warnedAboutInternalError = false;
  private needsFollowUpFlush = false;
  private workerPostScheduled = false;

  constructor(options: WorkerSinkOptions) {
    this.config = options.config;
    this.session = options.session;
    this.window = options.window;
    this.onSessionClosed = options.onSessionClosed;
    this.onCheckpointRequested = options.onCheckpointRequested;
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
    this.queueWorkerEvent(event);
    this.eventMetas.push({
      timestamp: event.timestamp,
      rawBytes,
      ...(event.type === EventType.FullSnapshot ? { fullSnapshot: true } : {}),
    });
    this.backpressure.addCurrentBytes(rawBytes);

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

  async prepareForSessionRotation(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.flushing !== undefined) {
      await this.flushing;
    }

    await this.flushInternal("manual");
  }

  resetAfterSessionRotation(): void {
    this.resetPipeline();
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
    const index = buildBatchIndex({
      session: this.session,
      seq,
      currentUrl: this.currentUrl,
      rrwebEvents: eventMetas,
      indexEvents,
    });
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

        if (result.ack.checkpoint === true) {
          this.onCheckpointRequested?.();
        }

        if (result.ack.drop === true) {
          this.stopAfterServerDrop();
          return true;
        }

        if (result.ack.closed === true) {
          this.handleSessionClosed();
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
          queuedEventCount: batch.eventMetas.length,
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

  private takeCurrentFinalBatch(maxBodyBytes: number): PagehideBatch | null {
    const indexEvents = this.indexEvents.drain();
    const taken = this.batcher.takeBatch(this.eventMetas.length);
    const eventMetas = this.eventMetas;
    const rrwebEvents = this.rrwebEvents;

    this.eventMetas = [];
    this.rrwebEvents = [];
    this.pendingWorkerEvents = [];
    this.workerPostScheduled = false;
    this.backpressure.removeCurrentBytes(taken.rawBytes);

    if (eventMetas.length === 0 && indexEvents.length === 0) {
      return null;
    }

    const seq = this.session.nextSeq();
    const finalBatch = buildPagehideBatch({
      encoder: this.encoder,
      session: this.session,
      currentUrl: this.currentUrl,
      seq,
      rrwebEvents,
      eventMetas,
      indexEvents,
      maxBodyBytes,
    });
    this.backpressure.recordDropped(finalBatch.droppedEventCount);
    return finalBatch.batch;
  }

  private dropCurrentFinalBatch(): null {
    const droppedCount = this.eventMetas.length;
    const taken = this.batcher.takeBatch(droppedCount);
    this.eventMetas = [];
    this.rrwebEvents = [];
    this.pendingWorkerEvents = [];
    this.workerPostScheduled = false;
    this.indexEvents.drain();
    this.backpressure.removeCurrentBytes(taken.rawBytes);
    this.backpressure.recordDropped(droppedCount);
    return null;
  }

  private queueSyncFinalBatch(batch: PagehideBatch): boolean {
    this.backpressure.addPendingBytes(batch.body.byteLength);
    // Unload transport is keepalive-only because sendBeacon cannot carry the
    // auth/session headers required by ingest.
    const queued = this.transport.queueBatchSync(
      {
        body: batch.body,
        index: batch.index,
        flags: batch.flags,
        keepalive: true,
      },
      () => {
        this.backpressure.recordDropped(batch.queuedEventCount);
      },
    );
    this.backpressure.removePendingBytes(batch.body.byteLength);
    if (!queued) {
      this.backpressure.recordDropped(batch.queuedEventCount);
    }
    return queued;
  }

  private async flushWorkerBatch(
    eventCount: number,
    rrwebEvents: readonly eventWithTime[],
    eventMetas: readonly EventMeta[],
  ) {
    this.flushPendingWorkerEvents();
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
    this.pendingWorkerEvents = [];
    this.workerPostScheduled = false;
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
    this.pendingWorkerEvents = [];
    this.workerPostScheduled = false;
    this.eventMetas = [];
    this.inFlightBatches = [];
    this.indexEvents.drain();
    this.batcher.reset();
    this.backpressure.resetCurrentBytes();
    this.workerHost.stop();
  }

  private handleSessionClosed(): void {
    if (this.onSessionClosed !== undefined) {
      this.onSessionClosed();
      return;
    }

    this.session.rotate();
    this.resetPipeline();
  }

  private queueWorkerEvent(event: eventWithTime): void {
    this.pendingWorkerEvents.push(event);

    if (this.workerPostScheduled) {
      return;
    }

    this.workerPostScheduled = true;
    const run = () => {
      this.workerPostScheduled = false;
      this.flushPendingWorkerEvents();
    };

    if (typeof this.window.queueMicrotask === "function") {
      this.window.queueMicrotask(run);
      return;
    }

    void Promise.resolve().then(run);
  }

  private flushPendingWorkerEvents(): void {
    this.workerPostScheduled = false;

    if (this.pendingWorkerEvents.length === 0) {
      return;
    }

    const events = this.pendingWorkerEvents.splice(0);
    this.workerHost.addEvents(events);
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
