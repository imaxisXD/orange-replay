import { FLAG_UNCOMPRESSED, SDK_FLUSH_DEFAULT_MS } from "@orange-replay/shared/constants";
import type { BatchIndex, IndexEvent } from "@orange-replay/shared/types";
import { encodeIngestBody } from "@orange-replay/shared/wire";
import {
  EventType,
  getSnapshotEstimatedBytes,
  IncrementalSource,
  type eventWithTime,
} from "@orange-replay/rrweb-fork";
import { markSdkInternalError } from "../internal-error.ts";
import { BackpressureController, SDK_BUFFER_CAP_BYTES } from "../pipeline/backpressure.ts";
import { BATCH_RAW_FLUSH_BYTES, Batcher, estimateRrwebEventBytes } from "../pipeline/batcher.ts";
import { Transport } from "../pipeline/transport.ts";
import { WorkerHost, type WorkerEvent } from "../pipeline/worker-host.ts";
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

const OVERSIZED_CATCH_UP_BYTES = SDK_BUFFER_CAP_BYTES / 32;

export class WorkerSink implements Sink {
  private readonly config: RecorderConfig;
  private readonly session: SessionManager;
  private readonly window: Window;
  private readonly workerHost: WorkerHost;
  private readonly transport: Transport;
  private readonly onSessionClosed?: () => void;
  private readonly onCheckpointRequested?: (required?: boolean) => void;
  private readonly onWorkerUnavailable?: () => void;
  private readonly encoder = new TextEncoder();
  private readonly indexEvents = new IndexEventBuffer();
  private readonly batcher: Batcher;
  private readonly backpressure = new BackpressureController();
  private rrwebEvents: eventWithTime[] = [];
  private pendingWorkerEvents: WorkerEvent[] = [];
  private eventMetas: EventMeta[] = [];
  private inFlightBatches: InFlightBatch[] = [];
  private currentUrl: string;
  private timerId: number | undefined;
  private stopped = false;
  private flushing: Promise<void> | undefined;
  private warnedAboutInternalError = false;
  private needsFollowUpFlush = false;
  private workerPostScheduled = false;
  private pagehideResetPending = false;
  private oversizedSnapshotBytes: number | undefined;
  private needsRequiredCheckpoint = false;
  private requiredCheckpointRequested = false;
  private requiredBaselineMissing = false;
  // Cadence flushes hold until the first full snapshot is buffered so the
  // session's first upload always carries a playable checkpoint instead of a
  // lone Meta event. Pagehide and memory-pressure drains stay ungated; the
  // hold ends when the snapshot arrives or any batch leaves the pipeline.
  private holdFlushes = true;
  private readonly pendingRequiredFinalBatches = new Set<object>();
  private pageHidden = false;

  constructor(options: WorkerSinkOptions) {
    this.config = options.config;
    this.session = options.session;
    this.window = options.window;
    this.onSessionClosed = options.onSessionClosed;
    this.onCheckpointRequested = options.onCheckpointRequested;
    this.onWorkerUnavailable = options.onWorkerUnavailable;
    this.currentUrl = scrubUrl(options.window.location.href, options.config.allowUrlParams);
    this.batcher = new Batcher({ flushMs: options.config.flushMs || SDK_FLUSH_DEFAULT_MS });
    let workerHostReady = false;
    let workerUnavailable = false;
    const handleWorkerUnavailable = () => {
      workerUnavailable = true;
      if (!workerHostReady || this.stopped) return;
      this.stopped = true;
      this.discardPipeline();
      this.onWorkerUnavailable?.();
    };
    this.workerHost =
      options.workerHost ??
      new WorkerHost({
        window: options.window,
        onUnavailable: handleWorkerUnavailable,
        warn(message) {
          console.warn(message);
        },
      });
    workerHostReady = true;
    if (workerUnavailable || !this.isAvailable()) this.stopped = true;
    this.transport =
      options.transport ??
      new Transport({
        config: options.config,
        fetch: options.fetch ?? options.window.fetch.bind(options.window),
      });
  }

  start(): void {
    if (this.stopped) return;
    this.scheduleTimer();
    this.window.document.addEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.addEventListener("pagehide", this.onPageHide, true);
    this.window.addEventListener("pageshow", this.onPageShow, true);
  }

  addRrwebEvent(event: eventWithTime): void {
    if (this.stopped) {
      return;
    }

    const isFullSnapshot = event.type === EventType.FullSnapshot;
    if (
      this.needsRequiredCheckpoint &&
      (!this.requiredCheckpointRequested || (event.type !== EventType.Meta && !isFullSnapshot))
    ) {
      this.backpressure.recordDropped(1);
      return;
    }

    const rawBytes = estimateRrwebEventBytes(event);
    const iframeSnapshotNode =
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.Mutation &&
      event.data.isAttachIframe === true &&
      event.data.adds.length === 1
        ? event.data.adds[0]!.node
        : undefined;
    const requiredSnapshotNode = isFullSnapshot ? event.data.node : iframeSnapshotNode;
    const bufferedBytes = this.backpressure.bufferedBytes();
    const startsOversizedSnapshot =
      requiredSnapshotNode !== undefined &&
      rawBytes > SDK_BUFFER_CAP_BYTES &&
      this.oversizedSnapshotBytes === undefined &&
      bufferedBytes <= OVERSIZED_CATCH_UP_BYTES;
    const maxBufferedBytes = startsOversizedSnapshot
      ? rawBytes + OVERSIZED_CATCH_UP_BYTES
      : this.oversizedSnapshotBytes === undefined
        ? undefined
        : Math.max(SDK_BUFFER_CAP_BYTES, this.oversizedSnapshotBytes + OVERSIZED_CATCH_UP_BYTES);
    const pressure = this.backpressure.canAccept(event, rawBytes, maxBufferedBytes);
    if (!pressure.accept) {
      if (pressure.tier === "keep") {
        if (this.oversizedSnapshotBytes !== undefined) {
          this.backpressure.recordDropped(1);
          this.needsRequiredCheckpoint = true;
        } else {
          this.disableAfterInternalError(new Error("Orange Replay reached its 4 MB memory limit."));
        }
      }
      return;
    }

    if (startsOversizedSnapshot) this.oversizedSnapshotBytes = rawBytes;
    if (isFullSnapshot) {
      // The buffer is playable now; the already-armed cadence timer ships it.
      this.holdFlushes = false;
      if (this.requiredCheckpointRequested) {
        this.needsRequiredCheckpoint = false;
        this.requiredCheckpointRequested = false;
      }
    }

    const decision = this.batcher.addEstimatedBytes(rawBytes);
    this.rrwebEvents.push(event);
    this.queueWorkerEvent(event, rawBytes);
    const requiredSnapshotBytes =
      requiredSnapshotNode === undefined
        ? undefined
        : getSnapshotEstimatedBytes(requiredSnapshotNode);
    this.eventMetas.push({
      timestamp: event.timestamp,
      rawBytes,
      ...(isFullSnapshot ? { fullSnapshot: true } : {}),
      ...(requiredSnapshotNode !== undefined ? { requiredSnapshot: true } : {}),
      ...(requiredSnapshotBytes !== undefined &&
      requiredSnapshotBytes > this.batcher.getPagehideRawFlushBytes()
        ? { pagehideRequiredOversized: true }
        : {}),
      ...(requiredSnapshotNode !== undefined && requiredSnapshotBytes === undefined
        ? { pagehideEstimateUnknown: true }
        : {}),
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

  async prepareForSnapshotPart(nextBytes?: number): Promise<void> {
    const safeNextBytes =
      nextBytes === undefined || !Number.isFinite(nextBytes)
        ? undefined
        : Math.max(0, Math.floor(nextBytes));
    while (!this.stopped) {
      if (this.flushing !== undefined) {
        await this.flushing;
        continue;
      }
      const bufferedBytes = this.backpressure.bufferedBytes();
      const nextPartIsOversized =
        safeNextBytes !== undefined && safeNextBytes > SDK_BUFFER_CAP_BYTES;
      const shouldDrain =
        this.oversizedSnapshotBytes !== undefined ||
        this.batcher.currentRawBytes() >= BATCH_RAW_FLUSH_BYTES ||
        (safeNextBytes !== undefined &&
          ((!nextPartIsOversized && bufferedBytes + safeNextBytes > SDK_BUFFER_CAP_BYTES) ||
            (nextPartIsOversized && bufferedBytes > OVERSIZED_CATCH_UP_BYTES)));
      if (!shouldDrain || this.eventMetas.length === 0) return;
      await this.flushInternal("manual");
    }
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
    if (this.stopped) return;

    this.stopped = true;
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    this.window.removeEventListener("pageshow", this.onPageShow, true);
    await this.flushing;
    await this.flushInternal("manual");
    this.workerHost.stop();
  }

  isAvailable(): boolean {
    const check = (this.workerHost as WorkerHost & { isAvailable?: () => boolean }).isAvailable;
    return typeof check !== "function" || check.call(this.workerHost);
  }

  private flushInternal(reason: InternalFlushReason): Promise<void> {
    if (reason === "pagehide") {
      this.pageHidden = true;
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
        const expectedPagehideReset =
          this.pagehideResetPending &&
          error instanceof Error &&
          error.message === "Orange Replay worker reset before flush.";
        if (!this.stopped && !expectedPagehideReset) this.disableAfterInternalError(error);
      })
      .finally(() => {
        this.pagehideResetPending = false;
        const shouldFlushAgain =
          !this.stopped &&
          (this.needsFollowUpFlush || this.batcher.currentRawBytes() > 0) &&
          this.batcher.currentRawBytes() >= BATCH_RAW_FLUSH_BYTES;

        this.needsFollowUpFlush = false;
        this.flushing = undefined;

        if (this.continueRequiredCheckpointRecovery()) return;

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
    // Nothing playable buffered yet — keep collecting; the timer re-arms in
    // flushInternal's finally and the snapshot arrival flushes promptly.
    if (this.holdFlushes && (reason === "timer" || reason === "visibility")) {
      return;
    }

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
    const hasOversizedSnapshot = containsOversizedSnapshot(eventMetas);
    const hasRequiredSnapshot = eventMetas.some((event) => event.requiredSnapshot === true);
    const hasFullSnapshot = eventMetas.some((event) => event.fullSnapshot === true);
    let chargedRawBytes = taken.rawBytes;

    if (eventMetas.length === 0 && indexEvents.length === 0) {
      return false;
    }

    // Once any batch leaves the pipeline the session exists server-side, so
    // holding cadence flushes for the initial checkpoint no longer helps.
    this.holdFlushes = false;

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
      const batch = await this.flushWorkerBatch(taken.eventCount);
      this.recordDroppedFromWorker(batch.droppedEventCount, eventMetas.length);
      if (this.requiredBaselineMissing && !hasFullSnapshot) {
        this.backpressure.recordDropped(eventMetas.length);
        return false;
      }
      const flags = batch.uncompressed ? FLAG_UNCOMPRESSED : 0;
      const body = encodeIngestBody(index, batch.payload);
      inFlight.body = body;
      inFlight.flags = flags;
      rrwebEvents.splice(0);
      this.backpressure.removeCurrentBytes(chargedRawBytes);
      chargedRawBytes = 0;
      if (hasOversizedSnapshot) this.oversizedSnapshotBytes = 0;

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
      if (result.dropped) {
        this.backpressure.recordDropped(eventMetas.length);
        if (hasRequiredSnapshot) this.markRequiredBaselineMissing();
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
    } catch (error) {
      this.backpressure.recordDropped(eventMetas.length);
      throw error;
    } finally {
      this.backpressure.removeCurrentBytes(chargedRawBytes);
      this.inFlightBatches = this.inFlightBatches.filter((batch) => batch !== inFlight);
      if (hasOversizedSnapshot) this.oversizedSnapshotBytes = undefined;
    }
  }

  private flushFinalBatchesSync(): void {
    let remainingBytes = this.batcher.getPagehideRawFlushBytes();
    let requiredBaselineMissing = false;

    for (const batch of this.inFlightBatches) {
      if (batch.finalQueued) {
        continue;
      }

      let queued = false;
      if (batch.body !== undefined && batch.body.byteLength <= remainingBytes) {
        queued = this.queueSyncFinalBatch({
          body: batch.body,
          index: batch.index,
          flags: batch.flags ?? 0,
          queuedEventCount: batch.eventMetas.length,
          droppedEventCount: 0,
          containsRequiredSnapshot: batch.eventMetas.some(
            (event) => event.requiredSnapshot === true,
          ),
        });
        if (queued) {
          remainingBytes -= batch.body.byteLength;
        }
      } else if (batch.body === undefined && remainingBytes > 0) {
        // The worker may still be serializing when the page closes. The raw
        // events remain available here, so build one bounded keepalive body
        // instead of silently losing the in-flight baseline.
        const finalBatch = buildPagehideBatch({
          encoder: this.encoder,
          session: this.session,
          currentUrl: this.currentUrl,
          seq: batch.seq,
          rrwebEvents: batch.rrwebEvents,
          eventMetas: batch.eventMetas,
          indexEvents: batch.indexEvents,
          maxBodyBytes: remainingBytes,
        });
        this.backpressure.recordDropped(finalBatch.droppedEventCount);
        if (finalBatch.batch !== null) {
          queued = this.queueSyncFinalBatch(finalBatch.batch);
          if (queued) remainingBytes -= finalBatch.batch.body.byteLength;
        }
      }

      if (!queued && batch.eventMetas.some((event) => event.requiredSnapshot === true)) {
        requiredBaselineMissing = true;
        this.markRequiredBaselineMissing();
      }

      batch.finalQueued = true;
    }

    const hasCurrentBatch = this.eventMetas.length > 0 || this.indexEvents.count() > 0;
    const currentBatch =
      !requiredBaselineMissing && remainingBytes > 0
        ? this.takeCurrentFinalBatch(remainingBytes)
        : this.dropCurrentFinalBatch();
    if (hasCurrentBatch) {
      this.pagehideResetPending = this.flushing !== undefined;
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
    const hasRequiredSnapshot = eventMetas.some((event) => event.requiredSnapshot === true);

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
    if (containsOversizedSnapshot(eventMetas)) {
      this.oversizedSnapshotBytes = undefined;
    }
    if (hasRequiredSnapshot && finalBatch.batch === null) this.markRequiredBaselineMissing();
    return finalBatch.batch;
  }

  private dropCurrentFinalBatch(): null {
    const droppedCount = this.eventMetas.length;
    const droppedOversizedSnapshot = containsOversizedSnapshot(this.eventMetas);
    const droppedRequiredSnapshot = this.eventMetas.some(
      (event) => event.requiredSnapshot === true,
    );
    const taken = this.batcher.takeBatch(droppedCount);
    this.eventMetas = [];
    this.rrwebEvents = [];
    this.pendingWorkerEvents = [];
    this.workerPostScheduled = false;
    this.indexEvents.drain();
    this.backpressure.removeCurrentBytes(taken.rawBytes);
    this.backpressure.recordDropped(droppedCount);
    if (droppedOversizedSnapshot) {
      this.oversizedSnapshotBytes = undefined;
    }
    if (droppedRequiredSnapshot) this.markRequiredBaselineMissing();
    return null;
  }

  private queueSyncFinalBatch(batch: PagehideBatch): boolean {
    this.holdFlushes = false;
    const requiredBatchToken = batch.containsRequiredSnapshot ? {} : undefined;
    if (requiredBatchToken !== undefined) {
      this.pendingRequiredFinalBatches.add(requiredBatchToken);
    }
    const finishRequiredBatch = (delivered: boolean): void => {
      if (
        requiredBatchToken !== undefined &&
        this.pendingRequiredFinalBatches.delete(requiredBatchToken) &&
        !delivered
      ) {
        this.markRequiredBaselineMissing();
      }
    };
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
        finishRequiredBatch(false);
      },
      () => finishRequiredBatch(true),
    );
    this.backpressure.removePendingBytes(batch.body.byteLength);
    if (!queued) {
      this.backpressure.recordDropped(batch.queuedEventCount);
      finishRequiredBatch(false);
    }
    return queued;
  }

  private async flushWorkerBatch(eventCount: number) {
    this.flushPendingWorkerEvents();
    return this.workerHost.flushBatch({ eventCount });
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
    this.clearPipelineBuffers();
    this.workerHost.reset();
  }

  private clearPipelineBuffers(): void {
    this.rrwebEvents = [];
    this.pendingWorkerEvents = [];
    this.workerPostScheduled = false;
    this.eventMetas = [];
    this.inFlightBatches = [];
    this.indexEvents.drain();
    this.batcher.reset();
    this.backpressure.resetCurrentBytes();
    this.oversizedSnapshotBytes = undefined;
    this.needsRequiredCheckpoint = false;
    this.requiredCheckpointRequested = false;
    this.requiredBaselineMissing = false;
    this.holdFlushes = true;
    this.pendingRequiredFinalBatches.clear();
  }

  private stopAfterServerDrop(): void {
    this.stopped = true;
    this.discardPipeline();
    this.workerHost.stop();
    this.onWorkerUnavailable?.();
  }

  private disableAfterInternalError(error: unknown): void {
    if (!this.warnedAboutInternalError) {
      this.warnedAboutInternalError = true;
      console.warn(
        "Orange Replay pipeline failed; recording stopped.",
        markSdkInternalError(error),
      );
    }

    this.stopped = true;
    this.discardPipeline();
    this.workerHost.stop();
    this.onWorkerUnavailable?.();
  }

  private discardPipeline(): void {
    this.clearTimer();
    this.window.document.removeEventListener("visibilitychange", this.onVisibilityChange, true);
    this.window.removeEventListener("pagehide", this.onPageHide, true);
    this.window.removeEventListener("pageshow", this.onPageShow, true);
    this.clearPipelineBuffers();
  }

  private continueRequiredCheckpointRecovery(): boolean {
    if (this.stopped || !this.needsRequiredCheckpoint) return false;
    if (this.requiredBaselineMissing) {
      this.discardEventsAfterMissingBaseline();
      this.requiredBaselineMissing = false;
    }
    if (!this.requiredCheckpointRequested && this.eventMetas.length > 0) {
      void this.flushInternal("threshold");
      return true;
    }
    if (!this.requiredCheckpointRequested && !this.pageHidden) {
      this.requiredCheckpointRequested = true;
      this.onCheckpointRequested?.(true);
    }
    if (!this.pageHidden && this.flushing === undefined) this.scheduleTimer();
    return true;
  }

  private markRequiredBaselineMissing(): void {
    this.needsRequiredCheckpoint = true;
    this.requiredBaselineMissing = true;
    this.requiredCheckpointRequested = false;
    if (!this.pageHidden && this.flushing === undefined) {
      this.continueRequiredCheckpointRecovery();
    }
  }

  private discardEventsAfterMissingBaseline(): void {
    const droppedCount = this.eventMetas.length;
    const taken = this.batcher.takeBatch(droppedCount);
    this.eventMetas = [];
    this.rrwebEvents = [];
    this.pendingWorkerEvents = [];
    this.workerPostScheduled = false;
    this.backpressure.removeCurrentBytes(taken.rawBytes);
    this.backpressure.recordDropped(droppedCount);
    this.workerHost.reset();
  }

  private handleSessionClosed(): void {
    if (this.onSessionClosed !== undefined) {
      this.onSessionClosed();
      return;
    }

    this.session.rotate();
    this.resetPipeline();
  }

  private queueWorkerEvent(event: eventWithTime, bytes: number): void {
    this.pendingWorkerEvents.push([event, bytes]);

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
    this.pageHidden = true;
    void this.flushInternal("pagehide");
  };

  private readonly onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted || this.stopped) return;
    this.pageHidden = false;
    if (this.pendingRequiredFinalBatches.size > 0) {
      this.pendingRequiredFinalBatches.clear();
      this.markRequiredBaselineMissing();
    }
    if (this.flushing === undefined && !this.continueRequiredCheckpointRecovery()) {
      this.scheduleTimer();
    }
  };
}

function containsOversizedSnapshot(events: readonly EventMeta[]): boolean {
  return events.some(
    (event) => event.requiredSnapshot === true && event.rawBytes > SDK_BUFFER_CAP_BYTES,
  );
}
