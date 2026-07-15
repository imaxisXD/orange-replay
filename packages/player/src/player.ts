import type { SessionManifest } from "@orange-replay/shared/types";
import { PlayerEmitter } from "./emitter.ts";
import { DEAD_CLICK_RESULT_WINDOW_MS, detectDeadClicks, type DeadClick } from "./friction.ts";
import { ReplayOverlay } from "./overlay.ts";
import {
  LiveFollowController,
  type LiveFollowEvent,
  type LiveReviewHistory,
} from "./player/live-follow-controller.ts";
import {
  RecordedSegmentLoader,
  type LoadedRecordedSegment,
} from "./player/recorded-segment-loader.ts";
import { ReplayEventStore } from "./player/replay-event-store.ts";
import { ReplaySurface } from "./player/replay-surface.ts";
import { buildTimeline } from "./timeline.ts";
import { eventsFromCheckpoint } from "./segments.ts";
import type {
  OrangePlayerEventName,
  OrangePlayerHandler,
  OrangePlayerOptions,
  PlayerErrorEvent,
  PlayerTimeline,
  ReplayEvent,
  SegmentWindow,
} from "./types.ts";
import { DecodeWorkerHost } from "./worker-host.ts";

const DEFAULT_SPEED = 1;
const MIN_SPEED = 0.1;
const MAX_SPEED = 16;
const LIVE_EVENT_RETENTION_MS = 5 * 60_000;
const REPLAY_END_TOLERANCE_MS = 100;

export class OrangePlayer {
  private readonly emitter = new PlayerEmitter();
  private readonly worker: DecodeWorkerHost;
  private readonly overlay: ReplayOverlay;
  private readonly surface: ReplaySurface;
  private readonly eventStore = new ReplayEventStore();
  private readonly segmentLoader: RecordedSegmentLoader;
  private readonly liveController: LiveFollowController;
  private readonly abortController = new AbortController();
  private manifest: SessionManifest | undefined;
  private timeline: PlayerTimeline | undefined;
  private readyPromise: Promise<SessionManifest>;
  private currentMs = 0;
  private speed = DEFAULT_SPEED;
  private skipInactivity = false;
  private playing = false;
  private playRequested = false;
  private destroyed = false;
  private playbackOperation = 0;
  private bufferingOperations = 0;
  private progressFrame: number | undefined;
  private recoveringLoadedEnd = false;
  private following = false;
  private liveRebuildAfterKeyframe = false;
  private liveReviewManifest: SessionManifest | undefined;
  private liveReviewWaitStarted = false;
  private reviewingLiveHistory = false;
  private liveReviewTailEvents: ReplayEvent[] = [];
  private liveReviewTailLoaded = false;
  private recordedCheckpoint: SegmentWindow["checkpoint"];
  private recordedReplayNeedsResetAfterLive = false;
  private rebasingRecordedReplay = false;
  private readonly deadClicksByTime = new Map<number, DeadClick>();

  constructor(container: HTMLElement, options: OrangePlayerOptions) {
    this.speed = cleanSpeed(options.speed);
    this.skipInactivity = options.skipInactivity === true;
    this.worker = new DecodeWorkerHost(options.worker);
    this.segmentLoader = new RecordedSegmentLoader({
      request: options,
      signal: this.abortController.signal,
      worker: this.worker,
      isDestroyed: () => this.destroyed,
      isFollowing: () => this.following,
      onSegmentLoaded: (loaded) => this.handleRecordedSegmentLoaded(loaded),
    });
    this.overlay = new ReplayOverlay(container, options.overlay);
    this.surface = new ReplaySurface({
      container,
      overlay: this.overlay,
      host: {
        onFinish: () => this.handleReplayerFinish(),
        onError: (message, error) => this.emitError(message, error),
      },
    });
    this.liveController = new LiveFollowController({
      request: options,
      signal: this.abortController.signal,
      worker: this.worker,
      host: {
        acceptsReplayTab: (tab, events, keyframeStarted) =>
          this.eventStore.acceptsLiveTab(tab, events, keyframeStarted),
        onEvent: (event) => this.handleLiveFollowEvent(event),
      },
    });
    this.readyPromise = this.load();
    // The event API does not require callers to await ready(). Keep the
    // internal promise handled while preserving rejection for explicit users.
    void this.readyPromise.catch(() => undefined);
  }

  on<K extends OrangePlayerEventName>(name: K, handler: OrangePlayerHandler<K>): () => void {
    return this.emitter.on(name, handler);
  }

  off<K extends OrangePlayerEventName>(name: K, handler: OrangePlayerHandler<K>): void {
    this.emitter.off(name, handler);
  }

  ready(): Promise<SessionManifest> {
    return this.readyPromise;
  }

  async play(): Promise<void> {
    const operation = ++this.playbackOperation;
    this.playRequested = true;
    await this.readyPromise;
    const manifest = this.manifest;
    if (!this.isCurrentPlaybackOperation(operation) || !this.playRequested) {
      return;
    }
    if (manifest === undefined) {
      throw new Error("This replay is not ready yet.");
    }

    if (this.following) {
      this.startPlayback();
      return;
    }

    await this.ensureSegmentForTime(this.currentMs);
    if (!this.isCurrentPlaybackOperation(operation) || !this.playRequested) {
      return;
    }
    if (this.isAtRecordedEnd(manifest, this.eventStore.events)) {
      this.currentMs = 0;
      this.overlay.draw(0);
      this.emitProgress();
    }
    if (!this.startPlayback()) {
      throw new Error("This session does not contain enough replay data to play.");
    }
  }

  pause(): void {
    if (this.following && !this.destroyed) {
      return;
    }
    this.playbackOperation += 1;
    this.stopPlayback();
  }

  private stopPlayback(): void {
    this.playRequested = false;
    this.playing = false;
    this.cancelProgressLoop();
    this.surface.pause();
    this.emitProgress();
    this.overlay.draw(this.currentMs);
  }

  async seek(ms: number): Promise<void> {
    if (this.following) {
      return;
    }
    const operation = ++this.playbackOperation;
    const shouldResume = this.playing || this.playRequested;
    this.stopPlayback();
    await this.readyPromise;
    const manifest = this.manifest;
    if (!this.isCurrentPlaybackOperation(operation)) {
      return;
    }
    if (manifest === undefined) {
      throw new Error("This replay is not ready yet.");
    }
    this.currentMs = clamp(ms, 0, manifest.durationMs);
    await this.ensureSegmentForTime(this.currentMs);
    if (!this.isCurrentPlaybackOperation(operation)) {
      return;
    }
    this.rebuildReplayer();
    this.overlay.draw(this.currentMs);
    this.emitProgress();

    if (shouldResume) {
      this.playRequested = true;
      this.startPlayback();
    }
  }

  setSpeed(value: number): void {
    this.updateProgressTime();
    this.speed = cleanSpeed(value);
    this.surface.setSpeed(this.speed);
  }

  setSkipInactivity(value: boolean): void {
    this.skipInactivity = value;
    this.surface.setSkipInactivity(value);
  }

  follow(): void {
    this.liveReviewManifest = undefined;
    if (this.following) {
      return;
    }

    this.playbackOperation += 1;
    this.stopPlayback();
    this.surface.destroyReplay();
    this.following = true;
    this.reviewingLiveHistory = false;
    this.liveReviewTailEvents = [];
    this.liveReviewTailLoaded = false;
    this.liveRebuildAfterKeyframe = true;
    this.liveController.startFollowing();
    void this.readyPromise.then(
      () => {
        if (!this.destroyed) {
          this.liveController.connect();
        }
      },
      (error) => this.emitError("Could not start live follow.", error),
    );
  }

  /**
   * Stop following after the current live history is loaded, then let the user
   * play and seek that local history while final details are still pending.
   */
  reviewLiveHistory(manifest: SessionManifest): void {
    if (
      this.destroyed ||
      (this.manifest !== undefined &&
        (manifest.projectId !== this.manifest.projectId ||
          manifest.sessionId !== this.manifest.sessionId))
    ) {
      return;
    }

    this.liveReviewManifest = manifest;
    if (!this.following || this.liveReviewWaitStarted) {
      return;
    }

    this.liveReviewWaitStarted = true;
    void (async () => {
      await this.liveController.refreshHistoryForReview();
      if (this.liveReviewManifest === undefined || !this.following || this.destroyed) return;

      const history = await this.liveController.stopAndTakeReviewHistory();
      const reviewManifest = this.liveReviewManifest;
      if (reviewManifest === undefined || !this.following || this.destroyed) {
        if (this.following && !this.destroyed) {
          this.liveController.startFollowing();
          this.liveController.connect();
        }
        return;
      }

      this.liveReviewManifest = undefined;
      this.startLiveHistoryReview(reviewManifest, history);
    })()
      .catch((error) => {
        if (!this.destroyed) {
          this.emitError("Could not prepare stored live history for review.", error, "warning");
        }
      })
      .finally(() => {
        this.liveReviewWaitStarted = false;
      });
  }

  /**
   * Adopt the immutable manifest without replacing the visible live replay.
   * The next recorded seek can rebuild from R2, while the current frame stays
   * on screen during the handoff.
   */
  finishLive(manifest: SessionManifest): void {
    if (
      this.destroyed ||
      (this.manifest !== undefined &&
        (manifest.projectId !== this.manifest.projectId ||
          manifest.sessionId !== this.manifest.sessionId))
    ) {
      return;
    }

    const wasFollowing = this.following;
    const wasReviewingLiveHistory = this.reviewingLiveHistory;
    this.liveReviewManifest = undefined;
    this.liveReviewWaitStarted = false;
    this.reviewingLiveHistory = false;
    this.liveReviewTailEvents = [];
    this.liveReviewTailLoaded = false;
    this.liveController.releaseHistoryWait();
    this.manifest = manifest;
    this.readyPromise = Promise.resolve(manifest);
    this.segmentLoader.useManifest(manifest);
    this.recordedCheckpoint = this.segmentLoader.segmentWindowAt(this.currentMs)?.checkpoint;
    this.timeline = buildTimeline(manifest.timeline, {
      startedAt: manifest.startedAt,
      durationMs: manifest.durationMs,
    });
    this.currentMs = clamp(this.currentMs, 0, manifest.durationMs);
    this.overlay.setSessionStart(manifest.startedAt);
    this.emitter.emit("timeline", this.timeline);
    this.emitter.emit("ready", manifest);
    this.emitProgress();

    if (!wasFollowing) {
      if (wasReviewingLiveHistory) this.recordedReplayNeedsResetAfterLive = true;
      return;
    }

    this.following = false;
    this.liveRebuildAfterKeyframe = false;
    this.liveController.stopFollowing();
    this.emitter.emit("live_finalized", manifest);

    if (!this.surface.hasReplayer && manifest.segments.length > 0) {
      void this.ensureSegmentForTime(this.currentMs)
        .then(() => {
          if (this.destroyed || this.following) return;
          this.rebuildReplayer();
          if (this.playRequested) this.startPlayback();
        })
        .catch((error) => {
          if (!this.destroyed) {
            this.emitError("Could not load the finalized replay.", error, "warning");
          }
        });
    } else {
      // The visible live frame stays mounted. Its events overlap the immutable
      // segments, so the first recorded play or seek must rebuild cleanly
      // instead of eagerly appending the same rrweb mutations a second time.
      this.recordedReplayNeedsResetAfterLive = true;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.pause();
    this.abortController.abort();
    this.following = false;
    this.liveReviewManifest = undefined;
    this.reviewingLiveHistory = false;
    this.liveReviewTailEvents = [];
    this.liveReviewTailLoaded = false;
    this.liveController.releaseHistoryWait();
    this.liveRebuildAfterKeyframe = false;
    this.liveController.stopFollowing();
    this.surface.stop();
    this.overlay.destroy();
    this.worker.stop();
    this.segmentLoader.clearLoadingSegments();
    this.emitter.clear();
  }

  private startLiveHistoryReview(manifest: SessionManifest, history: LiveReviewHistory): void {
    this.playbackOperation += 1;
    this.stopPlayback();
    this.following = false;
    this.reviewingLiveHistory = true;
    this.liveRebuildAfterKeyframe = false;
    this.liveController.stopFollowing();

    const latestReceivedAt = latestReviewTimestamp(history, manifest.startedAt);
    const durationMs = Math.max(
      manifest.durationMs,
      this.currentMs,
      latestReceivedAt - manifest.startedAt,
    );
    const reviewManifest: SessionManifest = {
      ...manifest,
      endedAt: Math.max(manifest.endedAt, manifest.startedAt + durationMs),
      durationMs,
      segments: history.segments,
      bytes: Math.max(
        manifest.bytes,
        history.segments.reduce((total, segment) => total + segment.bytes, 0),
      ),
    };
    this.manifest = reviewManifest;
    this.readyPromise = Promise.resolve(reviewManifest);
    this.segmentLoader.useManifest(reviewManifest);
    this.segmentLoader.clearLoadedSegments();
    this.liveReviewTailEvents = history.tailEvents;
    this.liveReviewTailLoaded = history.segments.length === 0;
    this.recordedReplayNeedsResetAfterLive = history.segments.length > 0;
    this.recordedCheckpoint = undefined;
    this.timeline = buildTimeline(reviewManifest.timeline, {
      startedAt: reviewManifest.startedAt,
      durationMs: reviewManifest.durationMs,
    });
    this.currentMs = clamp(this.currentMs, 0, reviewManifest.durationMs);
    this.overlay.setSessionStart(reviewManifest.startedAt);
    this.refreshFrictionTimeline();
    this.rebuildReplayer();
    this.emitter.emit("ready", reviewManifest);
    this.emitProgress();
  }

  private async load(): Promise<SessionManifest> {
    try {
      const manifest = await this.segmentLoader.loadManifest();
      if (this.destroyed) {
        return manifest;
      }
      this.manifest = manifest;
      this.segmentLoader.useManifest(manifest);
      const initialWindow = this.segmentLoader.segmentWindowAt(0);
      this.recordedCheckpoint = initialWindow?.checkpoint;
      this.eventStore.resetRecordedEvents(
        initialWindow?.checkpoint?.tab ?? this.segmentLoader.replayTab,
      );
      this.timeline = buildTimeline(manifest.timeline, {
        startedAt: manifest.startedAt,
        durationMs: manifest.durationMs,
      });
      this.overlay.setSessionStart(manifest.startedAt);
      this.emitter.emit("timeline", this.timeline);
      this.emitter.emit("ready", manifest);

      if (manifest.segments.length > 0) {
        this.prefetchSegment(0, "Could not prefetch the first replay segment.");
      }

      return manifest;
    } catch (error) {
      if (!this.destroyed) {
        this.emitError("Could not load replay session.", error);
      }
      throw error;
    }
  }

  private async ensureSegmentForTime(timeMs: number): Promise<void> {
    const window = this.segmentLoader.segmentWindowAt(timeMs);
    if (window === undefined || window.activeIndex < 0) {
      return;
    }

    if (this.recordedReplayNeedsResetAfterLive) {
      this.recordedReplayNeedsResetAfterLive = false;
      this.segmentLoader.resetLoadedWindow(window.startIndex);
      this.eventStore.resetRecordedEvents(window.checkpoint?.tab ?? this.segmentLoader.replayTab);
      this.surface.destroyReplay();
      this.overlay.reset();
      this.recordedCheckpoint = window.checkpoint;
      this.liveReviewTailLoaded = false;
    } else {
      this.prepareRecordedWindow(window);
    }

    this.beginBuffering(window.activeIndex);
    try {
      // Sanitizer state and rrweb mutations are ordered. Fetching a later
      // segment before its parent mutations can produce a different page.
      await this.segmentLoader.loadSegmentsInOrder(window.neededIndexes);
      this.appendLiveReviewTail(window);
    } finally {
      this.endBuffering(window.activeIndex);
    }

    for (const segmentIndex of window.prefetchIndexes) {
      this.prefetchSegment(segmentIndex, "Could not prefetch replay segment.");
    }
  }

  private handleRecordedSegmentLoaded(loaded: LoadedRecordedSegment): void {
    let events = this.eventStore.eventsForRecordedBatches(loaded.batches);
    if (this.recordedCheckpoint?.segmentIndex === loaded.index) {
      events = eventsFromCheckpoint(events, this.recordedCheckpoint.timestamp);
    }
    const addedEvents = this.addReplayEvents(events);
    this.emitter.emit("segment", {
      index: loaded.index,
      segment: loaded.segment,
      eventCount: events.length,
    });

    if (!this.surface.hasReplayer && addedEvents.length > 0) {
      this.rebuildReplayer();
    }
    this.maybeAdvanceRecordedCheckpoint();
  }
  private addReplayEvents(
    events: readonly ReplayEvent[],
    options: { liveEdgeMs?: number } = {},
  ): ReplayEvent[] {
    if (events.length === 0) {
      return [];
    }

    const sanitizedEvents = this.eventStore.add(events);
    this.syncReplayViewportForCurrentTime();
    this.overlay.addEvents(sanitizedEvents, options);

    this.surface.addEvents(sanitizedEvents);

    this.pruneLiveReplayState(options.liveEdgeMs);
    this.refreshFrictionTimeline();
    return sanitizedEvents;
  }

  private refreshFrictionTimeline(): void {
    const manifest = this.manifest;
    const timeline = this.timeline;
    if (manifest === undefined || timeline === undefined) {
      return;
    }

    const events = this.eventStore.events;
    const firstObserved = events[0]?.timestamp;
    const lastObserved = events.at(-1)?.timestamp;
    if (firstObserved !== undefined && lastObserved !== undefined) {
      const minimumClickTimestamp = firstObserved;
      const confirmedThrough = lastObserved - DEAD_CLICK_RESULT_WINDOW_MS;
      for (const timestamp of this.deadClicksByTime.keys()) {
        if (timestamp >= minimumClickTimestamp && timestamp <= confirmedThrough) {
          this.deadClicksByTime.delete(timestamp);
        }
      }
      for (const deadClick of detectDeadClicks(events, manifest.timeline, {
        minimumClickTimestamp,
      })) {
        this.deadClicksByTime.set(deadClick.t, deadClick);
      }
    }
    const deadClicks = [...this.deadClicksByTime.values()].toSorted(
      (left, right) => left.t - right.t,
    );
    this.timeline = {
      ...timeline,
      counts: { ...timeline.counts, deadClicks: deadClicks.length },
      deadClicks,
    };
    this.overlay.setDeadClicks(deadClicks);
    this.emitter.emit("timeline", this.timeline);
  }

  private rebuildReplayer(): void {
    const events = this.eventStore.events;
    if (events.length < 2 || this.manifest === undefined || this.destroyed) {
      return;
    }

    if (this.following && !this.liveController.keyframeStarted) {
      return;
    }

    this.surface.rebuild({
      events,
      speed: this.speed,
      skipInactivity: this.skipInactivity,
      following: this.following,
      currentTimestamp: this.currentTimestamp(),
      playerOffset: this.playerOffset(this.currentMs),
      shouldPlay: this.playing || this.playRequested,
    });
  }

  private syncReplayViewportForCurrentTime(): void {
    this.surface.syncViewport(this.eventStore.events, this.currentTimestamp());
  }
  private startPlayback(): boolean {
    if (this.destroyed || this.manifest === undefined) {
      return false;
    }

    if (this.following && this.liveController.waitingForKeyframe) {
      return false;
    }

    if (!this.surface.hasReplayer) {
      this.rebuildReplayer();
    }

    if (!this.surface.hasReplayer) {
      this.playing = false;
      this.playRequested = false;
      this.emitError("This session does not contain enough replay data to play.");
      return false;
    }

    this.playing = true;
    this.playRequested = true;
    if (!this.following) {
      this.surface.play(this.playerOffset(this.currentMs));
    }
    this.scheduleProgressLoop();
    this.prefetchAroundCurrentTime();
    return true;
  }

  private scheduleProgressLoop(): void {
    this.cancelProgressLoop();
    this.progressFrame = requestFrame(() => this.progressLoop());
  }

  private cancelProgressLoop(): void {
    if (this.progressFrame === undefined) {
      return;
    }

    cancelFrame(this.progressFrame);
    this.progressFrame = undefined;
  }

  private updateProgressTime(): void {
    const manifest = this.manifest;
    if (!this.playing || manifest === undefined) {
      return;
    }

    const replayerTime = this.currentReplayerTime();
    if (replayerTime === null) {
      return;
    }

    this.currentMs = Math.max(this.currentMs, Math.min(manifest.durationMs, replayerTime));
    this.maybeAdvanceRecordedCheckpoint();
  }

  private prefetchAroundCurrentTime(): void {
    if (this.manifest === undefined || this.following) {
      return;
    }

    const window = this.segmentLoader.segmentWindowAt(this.currentMs);
    if (window === undefined) {
      return;
    }
    for (const segmentIndex of window.prefetchIndexes) {
      this.prefetchSegment(segmentIndex, "Could not prefetch replay segment.");
    }
  }

  private prefetchSegment(index: number, errorMessage: string): void {
    if (
      this.segmentLoader.hasLoaded(index) ||
      this.segmentLoader.isLoading(index) ||
      this.destroyed
    ) {
      return;
    }

    void this.segmentLoader.loadSegment(index).catch((error) => {
      if (!this.destroyed) {
        this.emitError(errorMessage, error, "warning");
      }
    });
  }

  private handleReplayerFinish(): void {
    this.updateProgressTime();
    this.emitProgress();
    this.overlay.draw(this.currentMs);

    const manifest = this.manifest;
    if (this.following || manifest === undefined || this.destroyed) {
      return;
    }

    const nextSegmentIndex = this.segmentLoader.nextUnloadedSegmentIndex();
    if (nextSegmentIndex === undefined) {
      this.currentMs = manifest.durationMs;
      this.maybeAdvanceRecordedCheckpoint();
      this.finishIfDone();
      return;
    }

    if (this.recoveringLoadedEnd) {
      return;
    }

    const operation = this.playbackOperation;
    this.recoveringLoadedEnd = true;
    this.playing = false;
    this.cancelProgressLoop();
    this.beginBuffering(nextSegmentIndex);
    void this.segmentLoader
      .loadSegment(nextSegmentIndex)
      .then(() => {
        if (this.isCurrentPlaybackOperation(operation) && this.playRequested) {
          this.startPlayback();
        }
      })
      .catch((error) => {
        if (!this.destroyed) {
          this.playRequested = false;
          this.emitError("Could not load the next replay segment.", error);
        }
      })
      .finally(() => {
        this.recoveringLoadedEnd = false;
        this.endBuffering(nextSegmentIndex);
      });
  }

  private isAtRecordedEnd(manifest: SessionManifest, events: readonly ReplayEvent[]): boolean {
    if (this.segmentLoader.nextUnloadedSegmentIndex() !== undefined) {
      return false;
    }

    const lastEvent = events.at(-1);
    const lastEventMs =
      lastEvent === undefined ? manifest.durationMs : lastEvent.timestamp - manifest.startedAt;
    const replayEndMs = Math.min(manifest.durationMs, Math.max(0, lastEventMs));
    return this.currentMs >= Math.max(0, replayEndMs - REPLAY_END_TOLERANCE_MS);
  }

  private progressLoop(): void {
    const manifest = this.manifest;
    if (!this.playing || manifest === undefined || this.destroyed) {
      return;
    }

    this.updateProgressTime();
    this.emitProgress();
    this.overlay.draw(this.currentMs);
    this.prefetchAroundCurrentTime();

    if (this.currentMs >= manifest.durationMs && !this.following) {
      this.finishIfDone();
      return;
    }

    this.progressFrame = requestFrame(() => this.progressLoop());
  }

  private finishIfDone(): void {
    const manifest = this.manifest;
    if (this.following || manifest === undefined || this.currentMs < manifest.durationMs) {
      return;
    }

    this.playing = false;
    this.playRequested = false;
    this.cancelProgressLoop();
    this.currentMs = manifest.durationMs;
    this.maybeAdvanceRecordedCheckpoint();
    this.emitProgress();
    this.emitter.emit("ended", undefined);
  }

  private handleLiveFollowEvent(event: LiveFollowEvent): void {
    switch (event.type) {
      case "connection":
        this.emitLive();
        return;
      case "ended":
        this.emitter.emit("live_ended", undefined);
        return;
      case "error":
        this.emitError(event.message, event.error, event.severity);
        return;
      case "events":
        this.handleLiveEvents(event.events);
        return;
      case "finalized":
        this.finishLive(event.manifest);
        return;
      case "index":
        this.emitter.emit("live_index", event.index);
        return;
      case "keyframe_overflow":
        this.liveRebuildAfterKeyframe = true;
        return;
      case "open":
        if (!this.playing && !this.liveController.waitingForKeyframe) {
          void this.play();
        }
        return;
      case "reconnect":
        this.liveRebuildAfterKeyframe = this.surface.hasReplayer;
        return;
      case "reset":
        this.resetReplayEventsForLiveKeyframe();
        return;
      case "snapshot":
        this.emitter.emit("live_snapshot", event.snapshot);
        return;
      case "waiting":
        this.emitWaitingKeyframe();
        return;
    }
  }

  private handleLiveEvents(acceptedEvents: readonly ReplayEvent[]): void {
    const liveEdgeMs = this.latestEventOffsetMs(acceptedEvents);
    const addedEvents = this.addReplayEvents(acceptedEvents, { liveEdgeMs });
    if (addedEvents.length === 0) {
      return;
    }

    if (this.liveRebuildAfterKeyframe && !this.liveController.waitingForKeyframe) {
      this.liveRebuildAfterKeyframe = false;
      this.rebuildReplayer();
    }

    this.moveToLiveEdge(addedEvents);
  }

  private resetReplayEventsForLiveKeyframe(): void {
    this.eventStore.resetEvents();
    this.segmentLoader.clearLoadedSegments();
    this.recordedCheckpoint = undefined;
    this.deadClicksByTime.clear();
    this.surface.destroyReplay();
    this.overlay.reset();
    this.refreshFrictionTimeline();
  }

  private prepareRecordedWindow(window: SegmentWindow): void {
    if (sameCheckpoint(this.recordedCheckpoint, window.checkpoint)) {
      return;
    }

    this.segmentLoader.resetLoadedWindow(window.startIndex);
    this.eventStore.resetRecordedEvents(window.checkpoint?.tab ?? this.segmentLoader.replayTab);
    this.surface.destroyReplay();
    this.overlay.reset();
    this.recordedCheckpoint = window.checkpoint;
    this.liveReviewTailLoaded = false;
  }

  private appendLiveReviewTail(window: SegmentWindow): void {
    const manifest = this.manifest;
    if (
      !this.reviewingLiveHistory ||
      this.liveReviewTailLoaded ||
      this.liveReviewTailEvents.length === 0 ||
      manifest === undefined
    ) {
      return;
    }

    const lastSegmentIndex = manifest.segments.length - 1;
    if (
      lastSegmentIndex < 0 ||
      (window.activeIndex !== lastSegmentIndex && !window.neededIndexes.includes(lastSegmentIndex))
    ) {
      return;
    }

    const storedTail = this.eventStore.add(this.liveReviewTailEvents);
    this.overlay.addEvents(storedTail);
    // The segment loader may have just built a replay before the pending tail
    // was restored. Rebuild once from the complete ordered event list instead
    // of pushing tail mutations into a partly initialized rrweb instance.
    this.surface.destroyReplay();
    this.refreshFrictionTimeline();
    this.liveReviewTailLoaded = true;
  }

  private maybeAdvanceRecordedCheckpoint(): void {
    if (this.following || this.rebasingRecordedReplay || this.manifest === undefined) {
      return;
    }

    const checkpoint = this.segmentLoader.segmentWindowAt(this.currentMs)?.checkpoint;
    if (
      checkpoint === undefined ||
      sameCheckpoint(this.recordedCheckpoint, checkpoint) ||
      (this.recordedCheckpoint !== undefined &&
        checkpoint.timestamp <= this.recordedCheckpoint.timestamp)
    ) {
      return;
    }
    if (!this.eventStore.rebaseAtCheckpoint(checkpoint.timestamp)) {
      return;
    }

    this.rebasingRecordedReplay = true;
    try {
      this.recordedCheckpoint = checkpoint;
      this.segmentLoader.forgetLoadedBefore(checkpoint.segmentIndex);
      this.surface.destroyReplay();
      this.overlay.reset();
      this.overlay.addEvents(this.eventStore.events);
      this.refreshFrictionTimeline();
      this.rebuildReplayer();
    } finally {
      this.rebasingRecordedReplay = false;
    }
  }

  private moveToLiveEdge(events: readonly ReplayEvent[]): void {
    const manifest = this.manifest;
    if (manifest === undefined || events.length === 0) {
      return;
    }

    let lastTimestamp = -Infinity;
    for (const event of events) {
      if (event.timestamp > lastTimestamp) {
        lastTimestamp = event.timestamp;
      }
    }
    if (!Number.isFinite(lastTimestamp)) {
      return;
    }

    this.currentMs = Math.max(this.currentMs, lastTimestamp - manifest.startedAt);
    // Never re-arm startLive() here: each call resets rrweb's live baseline
    // to "now", silently discarding every event recorded before this frame
    // arrived. The baseline is anchored once in rebuildReplayer().
    if (!this.playing) {
      this.startPlayback();
    }
  }
  private playerOffset(timeMs: number): number {
    const manifest = this.manifest;
    const first = this.eventStore.events[0];
    if (manifest === undefined || first === undefined) {
      return Math.max(0, timeMs);
    }

    return Math.max(0, manifest.startedAt + timeMs - first.timestamp);
  }

  private currentTimestamp(): number {
    const manifest = this.manifest;
    if (manifest !== undefined) {
      return manifest.startedAt + this.currentMs;
    }

    return this.eventStore.events[0]?.timestamp ?? 0;
  }

  private currentReplayerTime(): number | null {
    const manifest = this.manifest;
    const firstEvent = this.eventStore.events[0];
    const replayerTime = this.surface.currentTime();
    if (manifest === undefined || firstEvent === undefined || replayerTime === null) {
      return null;
    }

    return Math.max(0, firstEvent.timestamp + replayerTime - manifest.startedAt);
  }

  private isCurrentPlaybackOperation(operation: number): boolean {
    return !this.destroyed && operation === this.playbackOperation;
  }

  private latestEventOffsetMs(events: readonly ReplayEvent[]): number | undefined {
    const manifest = this.manifest;
    if (manifest === undefined) {
      return undefined;
    }

    let latestTimestamp = -Infinity;
    for (const event of events) {
      if (event.timestamp > latestTimestamp) {
        latestTimestamp = event.timestamp;
      }
    }

    return Number.isFinite(latestTimestamp)
      ? Math.max(0, latestTimestamp - manifest.startedAt)
      : undefined;
  }

  private pruneLiveReplayState(liveEdgeMs: number | undefined): void {
    const manifest = this.manifest;
    if (!this.following || manifest === undefined || this.eventStore.events.length === 0) {
      return;
    }

    const liveEdgeTimestamp = manifest.startedAt + Math.max(0, liveEdgeMs ?? this.currentMs);
    const cutoff = liveEdgeTimestamp - LIVE_EVENT_RETENTION_MS;
    this.eventStore.pruneLiveEvents(cutoff);
  }

  private emitProgress(): void {
    const manifest = this.manifest;
    this.emitter.emit("progress", {
      currentMs: this.currentMs,
      durationMs: manifest?.durationMs ?? 0,
    });
  }

  private emitLive(): void {
    this.emitter.emit("live", {
      following: this.following,
      connected: this.liveController.connected,
    });
  }

  private emitWaitingKeyframe(): void {
    this.emitter.emit("waiting_keyframe", {
      waiting: this.liveController.waitingForKeyframe,
    });
  }

  private emitError(
    message: string,
    error?: unknown,
    severity: NonNullable<PlayerErrorEvent["severity"]> = "fatal",
  ): void {
    const event: PlayerErrorEvent = { message, severity };
    if (error !== undefined) {
      event.error = error;
    }
    this.emitter.emit("error", event);
  }

  private beginBuffering(segmentIndex?: number): void {
    this.bufferingOperations += 1;
    if (this.bufferingOperations === 1) {
      this.emitter.emit("buffering", { buffering: true, segmentIndex });
    }
  }

  private endBuffering(segmentIndex?: number): void {
    this.bufferingOperations = Math.max(0, this.bufferingOperations - 1);
    if (this.bufferingOperations === 0) {
      this.emitter.emit("buffering", { buffering: false, segmentIndex });
    }
  }
}

function cleanSpeed(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SPEED;
  }

  return clamp(value, MIN_SPEED, MAX_SPEED);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sameCheckpoint(
  left: SegmentWindow["checkpoint"],
  right: SegmentWindow["checkpoint"],
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.segmentIndex === right.segmentIndex &&
    left.batch === right.batch &&
    left.timestamp === right.timestamp &&
    left.tab === right.tab
  );
}

function latestReviewTimestamp(history: LiveReviewHistory, fallback: number): number {
  let latest = fallback;
  for (const segment of history.segments) latest = Math.max(latest, segment.t1);
  for (const event of history.tailEvents) latest = Math.max(latest, event.timestamp);
  return latest;
}

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }

  return Number(setTimeout(callback, 16));
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(id);
    return;
  }

  clearTimeout(id);
}
