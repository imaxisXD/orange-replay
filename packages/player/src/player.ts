import type { SessionManifest } from "@orange-replay/shared/types";
import { PlayerEmitter } from "./emitter.ts";
import { DEAD_CLICK_RESULT_WINDOW_MS, detectDeadClicks, type DeadClick } from "./friction.ts";
import { ReplayOverlay } from "./overlay.ts";
import { LiveFollowController } from "./player/live-follow-controller.ts";
import { RecordedPlaybackController } from "./player/recorded-playback-controller.ts";
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

export class OrangePlayer {
  private readonly emitter = new PlayerEmitter();
  private readonly worker: DecodeWorkerHost;
  private readonly overlay: ReplayOverlay;
  private readonly surface: ReplaySurface;
  private readonly eventStore = new ReplayEventStore();
  private readonly segmentLoader: RecordedSegmentLoader;
  private readonly playback: RecordedPlaybackController;
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
  private following = false;
  private liveRebuildAfterKeyframe = false;
  private recordedCheckpoint: SegmentWindow["checkpoint"];
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
        onFinish: () => this.playback.handleReplayerFinish(),
        onError: (message, error) => this.emitError(message, error),
      },
    });
    this.playback = new RecordedPlaybackController({
      segments: this.segmentLoader,
      host: {
        isPlaying: () => this.playing,
        isDestroyed: () => this.destroyed,
        isFollowing: () => this.following,
        isPlayRequested: () => this.playRequested,
        isCurrentPlaybackOperation: (operation) => this.isCurrentPlaybackOperation(operation),
        getManifest: () => this.manifest,
        getCurrentMs: () => this.currentMs,
        getPlaybackOperation: () => this.playbackOperation,
        setCurrentMs: (currentMs) => {
          this.currentMs = currentMs;
          this.maybeAdvanceRecordedCheckpoint();
        },
        setPlaying: (playing) => {
          this.playing = playing;
        },
        setPlayRequested: (playRequested) => {
          this.playRequested = playRequested;
        },
        readRenderedTime: () => this.currentReplayerTime(),
        emitProgress: () => this.emitProgress(),
        drawOverlay: () => this.overlay.draw(this.currentMs),
        emitEnded: () => this.emitter.emit("ended", undefined),
        startPlayback: () => {
          this.startPlayback();
        },
        beginBuffering: (segmentIndex) => this.beginBuffering(segmentIndex),
        endBuffering: (segmentIndex) => this.endBuffering(segmentIndex),
        onError: (message, error, severity) => this.emitError(message, error, severity),
      },
    });
    this.liveController = new LiveFollowController({
      request: options,
      signal: this.abortController.signal,
      worker: this.worker,
      host: {
        isFollowing: () => this.following,
        isDestroyed: () => this.destroyed,
        acceptsReplayTab: (tab, events, keyframeStarted) =>
          this.eventStore.acceptsLiveTab(tab, events, keyframeStarted),
        onLiveEvents: (events) => this.handleLiveEvents(events),
        onLiveIndex: (index) => this.emitter.emit("live_index", index),
        onLiveSnapshot: (snapshot) => this.emitter.emit("live_snapshot", snapshot),
        onSessionEnded: () => this.emitter.emit("live_ended", undefined),
        onResetReplayEvents: () => this.resetReplayEventsForLiveKeyframe(),
        onReconnectStarted: () => {
          this.liveRebuildAfterKeyframe = this.surface.hasReplayer;
        },
        onKeyframeOverflow: () => {
          this.liveRebuildAfterKeyframe = true;
        },
        onSocketOpen: () => {
          if (!this.playing && !this.liveController.waitingForKeyframe) {
            void this.play();
          }
        },
        onConnectionChanged: () => this.emitLive(),
        onWaitingChanged: () => this.emitWaitingKeyframe(),
        onError: (message, error, severity) => this.emitError(message, error, severity),
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
    const manifest = await this.readyPromise;
    if (!this.isCurrentPlaybackOperation(operation) || !this.playRequested) {
      return;
    }

    if (this.following) {
      this.startPlayback();
      return;
    }

    await this.ensureSegmentForTime(this.currentMs);
    if (!this.isCurrentPlaybackOperation(operation) || !this.playRequested) {
      return;
    }
    if (this.playback.isAtRecordedEnd(manifest, this.eventStore.events)) {
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
    this.playback.cancelProgressLoop();
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
    const manifest = await this.readyPromise;
    if (!this.isCurrentPlaybackOperation(operation)) {
      return;
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
    this.playback.updateProgressTime();
    this.speed = cleanSpeed(value);
    this.surface.setSpeed(this.speed);
  }

  setSkipInactivity(value: boolean): void {
    this.skipInactivity = value;
    this.surface.setSkipInactivity(value);
  }

  follow(): void {
    if (this.following) {
      return;
    }

    this.playbackOperation += 1;
    this.stopPlayback();
    this.surface.destroyReplay();
    this.following = true;
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

  destroy(): void {
    this.destroyed = true;
    this.pause();
    this.abortController.abort();
    this.following = false;
    this.liveRebuildAfterKeyframe = false;
    this.liveController.disconnect();
    this.surface.stop();
    this.overlay.destroy();
    this.worker.stop();
    this.segmentLoader.clearLoadingSegments();
    this.emitter.clear();
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
        this.playback.prefetchSegment(0, "Could not prefetch the first replay segment.");
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

    this.prepareRecordedWindow(window);

    this.beginBuffering(window.activeIndex);
    try {
      // Sanitizer state and rrweb mutations are ordered. Fetching a later
      // segment before its parent mutations can produce a different page.
      await this.segmentLoader.loadSegmentsInOrder(window.neededIndexes);
    } finally {
      this.endBuffering(window.activeIndex);
    }

    for (const segmentIndex of window.prefetchIndexes) {
      this.playback.prefetchSegment(segmentIndex, "Could not prefetch replay segment.");
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
    if (events.length === 0 || this.manifest === undefined || this.destroyed) {
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
    this.playback.scheduleProgressLoop();
    this.playback.prefetchAroundCurrentTime();
    return true;
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
