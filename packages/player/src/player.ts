import { Replayer } from "rrweb";
import type { SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import { fetchSegmentBytes, liveSocketUrl, loadSession } from "./api.ts";
import { PlayerEmitter } from "./emitter.ts";
import {
  acceptLiveEventsAfterKeyframe,
  acceptLiveFrame,
  createLiveFrameState,
  createLiveKeyframeBuffer,
  startWaitingForKeyframe,
  stopWaitingForKeyframe,
  type LiveFrameState,
  type LiveKeyframeBuffer,
} from "./live.ts";
import { ReplayOverlay } from "./overlay.ts";
import {
  chooseSegmentWindow,
  decodeSegmentEvents,
  eventKey,
  findSegmentIndex,
} from "./segments.ts";
import { applySkipInactivity, buildTimeline, findInactivityGaps } from "./timeline.ts";
import type {
  InactivityGap,
  OrangePlayerEventName,
  OrangePlayerHandler,
  OrangePlayerOptions,
  PlayerErrorEvent,
  PlayerTimeline,
  ReplayEvent,
} from "./types.ts";
import { DecodeWorkerHost } from "./worker-host.ts";

const DEFAULT_SPEED = 1;
const MIN_SPEED = 0.1;
const MAX_SPEED = 16;
const LIVE_BASE_RECONNECT_MS = 500;
const LIVE_MAX_RECONNECT_MS = 8_000;

export class OrangePlayer {
  private readonly container: HTMLElement;
  private readonly options: OrangePlayerOptions;
  private readonly emitter = new PlayerEmitter();
  private readonly worker: DecodeWorkerHost;
  private readonly overlay: ReplayOverlay;
  private readonly loadedSegments = new Set<number>();
  private readonly loadingSegments = new Map<number, Promise<void>>();
  private readonly liveFrames: LiveFrameState = createLiveFrameState();
  private readonly liveKeyframes: LiveKeyframeBuffer = createLiveKeyframeBuffer();
  private readonly seenEventKeys = new Set<string>();
  private manifest: SessionManifest | undefined;
  private timeline: PlayerTimeline | undefined;
  private gaps: InactivityGap[] = [];
  private events: ReplayEvent[] = [];
  private replayer: Replayer | undefined;
  private readyPromise: Promise<SessionManifest>;
  private currentMs = 0;
  private speed = DEFAULT_SPEED;
  private skipInactivity = false;
  private playing = false;
  private playRequested = false;
  private destroyed = false;
  private progressFrame: number | undefined;
  private lastProgressAt = 0;
  private liveSocket: WebSocket | undefined;
  private liveReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private liveReconnectAttempt = 0;
  private following = false;
  private liveConnected = false;
  private liveRebuildAfterKeyframe = false;

  constructor(container: HTMLElement, options: OrangePlayerOptions) {
    this.container = container;
    this.options = options;
    this.speed = cleanSpeed(options.speed);
    this.skipInactivity = options.skipInactivity === true;
    this.worker = new DecodeWorkerHost(options.worker);
    this.overlay = new ReplayOverlay(container, options.overlay);
    this.readyPromise = this.load();
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
    this.playRequested = true;
    await this.readyPromise;
    await this.ensureSegmentForTime(this.currentMs);
    this.startPlayback();
  }

  pause(): void {
    this.playRequested = false;
    this.playing = false;
    this.cancelProgressLoop();
    this.replayer?.pause(this.playerOffset(this.currentMs));
    this.emitProgress();
    this.overlay.draw(this.currentMs);
  }

  async seek(ms: number): Promise<void> {
    const manifest = await this.readyPromise;
    const shouldResume = this.playing || this.playRequested;
    this.pause();
    this.currentMs = clamp(ms, 0, manifest.durationMs);
    await this.ensureSegmentForTime(this.currentMs);
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
    this.replayer?.setConfig({ speed: this.speed });
  }

  setSkipInactivity(value: boolean): void {
    this.skipInactivity = value;
    this.replayer?.setConfig({
      skipInactive: value,
      inactivePeriodThreshold: 5_000,
    });
  }

  follow(): void {
    if (this.following) {
      return;
    }

    this.following = true;
    startWaitingForKeyframe(this.liveKeyframes);
    this.emitLive();
    this.emitWaitingKeyframe();
    void this.readyPromise.then(
      () => {
        if (!this.destroyed) {
          this.connectLive();
        }
      },
      (error) => this.emitError("Could not start live follow.", error),
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.pause();
    this.disconnectLive();
    this.replayer?.destroy();
    this.replayer = undefined;
    this.overlay.destroy();
    this.worker.stop();
    this.emitter.clear();
  }

  private async load(): Promise<SessionManifest> {
    try {
      const manifest = await loadSession(this.options.api, {
        projectId: this.options.projectId,
        sessionId: this.options.sessionId,
        token: this.options.token,
      });
      this.manifest = manifest;
      this.timeline = buildTimeline(manifest.timeline, {
        startedAt: manifest.startedAt,
        durationMs: manifest.durationMs,
      });
      this.gaps = findInactivityGaps(manifest.timeline, {
        startedAt: manifest.startedAt,
        durationMs: manifest.durationMs,
      });
      this.overlay.setSessionStart(manifest.startedAt);
      this.emitter.emit("timeline", this.timeline);
      this.emitter.emit("ready", manifest);

      if (manifest.segments.length > 0) {
        void this.loadSegment(0).catch((error) => {
          this.emitError("Could not prefetch the first replay segment.", error);
        });
      }

      return manifest;
    } catch (error) {
      this.emitError("Could not load replay session.", error);
      throw error;
    }
  }

  private async ensureSegmentForTime(timeMs: number): Promise<void> {
    const manifest = this.manifest;
    if (manifest === undefined) {
      return;
    }

    const index = findSegmentIndex(manifest.segments, manifest.startedAt, timeMs);
    const window = chooseSegmentWindow(manifest.segments, index);
    if (window.activeIndex < 0) {
      return;
    }

    this.emitter.emit("buffering", { buffering: true, segmentIndex: window.activeIndex });
    try {
      await Promise.all(window.neededIndexes.map((segmentIndex) => this.loadSegment(segmentIndex)));
    } finally {
      this.emitter.emit("buffering", { buffering: false, segmentIndex: window.activeIndex });
    }

    for (const segmentIndex of window.prefetchIndexes) {
      void this.loadSegment(segmentIndex).catch((error) => {
        this.emitError("Could not prefetch replay segment.", error);
      });
    }
  }

  private loadSegment(index: number): Promise<void> {
    const manifest = this.manifest;
    if (manifest === undefined || index < 0 || index >= manifest.segments.length) {
      return Promise.resolve();
    }

    if (this.loadedSegments.has(index)) {
      return Promise.resolve();
    }

    const activeLoad = this.loadingSegments.get(index);
    if (activeLoad !== undefined) {
      return activeLoad;
    }

    const segment = manifest.segments[index];
    if (segment === undefined) {
      return Promise.resolve();
    }

    const load = this.fetchAndDecodeSegment(index, segment).finally(() => {
      this.loadingSegments.delete(index);
    });
    this.loadingSegments.set(index, load);
    return load;
  }

  private async fetchAndDecodeSegment(index: number, segment: SegmentRef): Promise<void> {
    const bytes = await fetchSegmentBytes(this.options.api, {
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      token: this.options.token,
      segment,
    });
    const events = await decodeSegmentEvents(bytes, this.worker);
    this.loadedSegments.add(index);
    const addedEvents = this.addReplayEvents(events);
    this.emitter.emit("segment", { index, segment, eventCount: events.length });

    if (this.replayer === undefined && addedEvents.length > 0) {
      this.rebuildReplayer();
    }
  }

  private addReplayEvents(
    events: readonly ReplayEvent[],
    options: { liveEdgeMs?: number } = {},
  ): ReplayEvent[] {
    if (events.length === 0) {
      return [];
    }

    const newEvents = this.newReplayEvents(events);
    if (newEvents.length === 0) {
      return [];
    }

    this.appendReplayEvents(newEvents);
    this.overlay.addEvents(newEvents, options);

    if (this.replayer !== undefined) {
      for (const event of newEvents) {
        this.replayer.addEvent(event);
      }
    }

    return newEvents;
  }

  private rebuildReplayer(): void {
    if (this.events.length === 0 || this.manifest === undefined || this.destroyed) {
      return;
    }

    if (this.following && !this.liveKeyframes.started) {
      return;
    }

    this.replayer?.destroy();
    this.replayer = new Replayer([...this.events], {
      root: this.container,
      speed: this.speed,
      skipInactive: this.skipInactivity,
      inactivePeriodThreshold: 5_000,
      showWarning: false,
      showDebug: false,
      mouseTail: false,
      useVirtualDom: true,
      liveMode: this.following,
      logger: {
        log() {
          /* keep the player headless */
        },
        warn() {
          /* keep the player headless */
        },
      },
    });
    this.replayer.on("finish", () => this.finishIfDone());
    this.overlay.bringToFront();

    if (this.following) {
      // Anchor the live baseline at the last buffered event: rrweb discards
      // addEvent() payloads older than the baseline, so "now" would drop
      // every frame that was recorded before it arrived here.
      this.replayer.startLive(this.events.at(-1)?.timestamp);
    } else if (this.playing || this.playRequested) {
      this.replayer.play(this.playerOffset(this.currentMs));
    } else {
      this.replayer.pause(this.playerOffset(this.currentMs));
    }
  }

  private startPlayback(): void {
    if (this.destroyed || this.manifest === undefined) {
      return;
    }

    if (this.following && this.liveKeyframes.waiting) {
      this.emitter.emit("buffering", { buffering: false });
      return;
    }

    if (this.replayer === undefined) {
      this.rebuildReplayer();
    }

    if (this.replayer === undefined) {
      this.emitter.emit("buffering", { buffering: true });
      return;
    }

    this.emitter.emit("buffering", { buffering: false });
    this.playing = true;
    this.playRequested = true;
    this.lastProgressAt = nowMs();
    this.replayer.play(this.playerOffset(this.currentMs));
    this.scheduleProgressLoop();
    this.prefetchAroundCurrentTime();
  }

  private scheduleProgressLoop(): void {
    this.cancelProgressLoop();
    this.progressFrame = requestFrame(() => this.progressLoop());
  }

  private progressLoop(): void {
    if (!this.playing || this.manifest === undefined || this.destroyed) {
      return;
    }

    this.updateProgressTime();
    this.emitProgress();
    this.overlay.draw(this.currentMs);
    this.prefetchAroundCurrentTime();

    if (this.currentMs >= this.manifest.durationMs && !this.following) {
      this.finishIfDone();
      return;
    }

    this.progressFrame = requestFrame(() => this.progressLoop());
  }

  private updateProgressTime(): void {
    if (!this.playing || this.manifest === undefined) {
      this.lastProgressAt = nowMs();
      return;
    }

    const currentTime = nowMs();
    const elapsedMs = Math.max(0, currentTime - this.lastProgressAt) * this.speed;
    this.lastProgressAt = currentTime;
    const next = Math.min(this.manifest.durationMs, this.currentMs + elapsedMs);
    const skipped = this.skipInactivity
      ? applySkipInactivity(this.currentMs, next, this.gaps)
      : null;

    if (skipped?.skipped === true) {
      this.currentMs = skipped.timeMs;
      this.replayer?.play(this.playerOffset(this.currentMs));
      return;
    }

    this.currentMs = Math.max(this.currentMs, skipped?.timeMs ?? next);
  }

  private prefetchAroundCurrentTime(): void {
    const manifest = this.manifest;
    if (manifest === undefined) {
      return;
    }

    const index = findSegmentIndex(manifest.segments, manifest.startedAt, this.currentMs);
    const window = chooseSegmentWindow(manifest.segments, index);
    for (const segmentIndex of window.prefetchIndexes) {
      void this.loadSegment(segmentIndex).catch((error) => {
        this.emitError("Could not prefetch replay segment.", error);
      });
    }
  }

  private finishIfDone(): void {
    if (
      this.following ||
      this.manifest === undefined ||
      this.currentMs < this.manifest.durationMs
    ) {
      return;
    }

    this.playing = false;
    this.playRequested = false;
    this.cancelProgressLoop();
    this.currentMs = this.manifest.durationMs;
    this.emitProgress();
    this.emitter.emit("ended", undefined);
  }

  private connectLive(reconnecting = false): void {
    if (!this.following || this.destroyed) {
      return;
    }

    if (reconnecting) {
      startWaitingForKeyframe(this.liveKeyframes);
      this.liveRebuildAfterKeyframe = this.replayer !== undefined;
      this.emitWaitingKeyframe();
    }

    const token = this.options.token;
    if (token === undefined || token.length === 0) {
      this.emitError("Live follow needs a token query value.");
      return;
    }

    const socket = new WebSocket(
      liveSocketUrl(this.options.api, {
        projectId: this.options.projectId,
        sessionId: this.options.sessionId,
        token,
      }),
    );
    socket.binaryType = "arraybuffer";
    this.liveSocket = socket;

    socket.onopen = () => {
      this.liveReconnectAttempt = 0;
      this.liveConnected = true;
      this.emitLive();
      if (!this.playing && !this.liveKeyframes.waiting) {
        void this.play();
      }
    };

    socket.onmessage = (event) => {
      this.handleLiveMessage(event.data);
    };

    socket.onerror = () => {
      this.emitError("Live socket failed.");
    };

    socket.onclose = () => {
      this.liveConnected = false;
      this.emitLive();
      if (this.following && !this.destroyed) {
        this.scheduleLiveReconnect();
      }
    };
  }

  private handleLiveMessage(data: unknown): void {
    if (typeof data === "string") {
      return;
    }

    if (!(data instanceof ArrayBuffer)) {
      return;
    }

    let frame;
    try {
      frame = acceptLiveFrame(this.liveFrames, data);
    } catch (error) {
      this.emitError("Could not read live replay frame.", error);
      return;
    }

    if (frame === null) {
      return;
    }

    void this.worker
      .decodeBatch(frame.payload)
      .then((events) => {
        const acceptedEvents = this.acceptLiveReplayEvents(events);
        if (acceptedEvents.length === 0) {
          return;
        }

        const liveEdgeMs = this.latestEventOffsetMs(acceptedEvents);
        const addedEvents = this.addReplayEvents(acceptedEvents, { liveEdgeMs });
        if (addedEvents.length === 0) {
          return;
        }

        if (this.liveRebuildAfterKeyframe && !this.liveKeyframes.waiting) {
          this.liveRebuildAfterKeyframe = false;
          this.rebuildReplayer();
        }

        this.moveToLiveEdge(addedEvents);
      })
      .catch((error) => {
        this.emitError("Could not decode live replay frame.", error);
      });
  }

  private acceptLiveReplayEvents(events: readonly ReplayEvent[]): ReplayEvent[] {
    if (!this.following || this.liveKeyframes.started) {
      return [...events];
    }

    const wasWaiting = this.liveKeyframes.waiting;
    const acceptedEvents = acceptLiveEventsAfterKeyframe(this.liveKeyframes, events);
    if (wasWaiting !== this.liveKeyframes.waiting) {
      this.emitWaitingKeyframe();
    }
    return acceptedEvents;
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

  private scheduleLiveReconnect(): void {
    if (this.liveReconnectTimer !== undefined) {
      clearTimeout(this.liveReconnectTimer);
    }

    const delay = Math.min(
      LIVE_MAX_RECONNECT_MS,
      LIVE_BASE_RECONNECT_MS * 2 ** this.liveReconnectAttempt,
    );
    this.liveReconnectAttempt += 1;
    this.liveReconnectTimer = setTimeout(() => {
      this.liveReconnectTimer = undefined;
      this.connectLive(true);
    }, delay);
  }

  private disconnectLive(): void {
    this.following = false;
    this.liveConnected = false;
    this.liveRebuildAfterKeyframe = false;
    stopWaitingForKeyframe(this.liveKeyframes);

    if (this.liveReconnectTimer !== undefined) {
      clearTimeout(this.liveReconnectTimer);
      this.liveReconnectTimer = undefined;
    }

    if (this.liveSocket !== undefined) {
      this.liveSocket.onclose = null;
      this.liveSocket.close();
      this.liveSocket = undefined;
    }

    this.emitLive();
    this.emitWaitingKeyframe();
  }

  private playerOffset(timeMs: number): number {
    const manifest = this.manifest;
    const first = this.events[0];
    if (manifest === undefined || first === undefined) {
      return Math.max(0, timeMs);
    }

    return Math.max(0, manifest.startedAt + timeMs - first.timestamp);
  }

  private newReplayEvents(events: readonly ReplayEvent[]): ReplayEvent[] {
    const newEvents: ReplayEvent[] = [];
    for (const event of events) {
      const key = eventKey(event);
      if (this.seenEventKeys.has(key)) {
        continue;
      }

      this.seenEventKeys.add(key);
      newEvents.push(event);
    }

    return newEvents;
  }

  private appendReplayEvents(events: readonly ReplayEvent[]): void {
    const orderedEvents = [...events].sort((left, right) => left.timestamp - right.timestamp);
    const lastEvent = this.events.at(-1);
    const firstNewEvent = orderedEvents[0];

    if (
      lastEvent === undefined ||
      firstNewEvent === undefined ||
      firstNewEvent.timestamp >= lastEvent.timestamp
    ) {
      this.events.push(...orderedEvents);
      return;
    }

    for (const event of orderedEvents) {
      insertReplayEvent(this.events, event);
    }
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
      connected: this.liveConnected,
    });
  }

  private emitWaitingKeyframe(): void {
    this.emitter.emit("waiting_keyframe", {
      waiting: this.liveKeyframes.waiting,
    });
  }

  private emitError(message: string, error?: unknown): void {
    const event: PlayerErrorEvent = { message };
    if (error !== undefined) {
      event.error = error;
    }
    this.emitter.emit("error", event);
  }

  private cancelProgressLoop(): void {
    if (this.progressFrame === undefined) {
      return;
    }

    cancelFrame(this.progressFrame);
    this.progressFrame = undefined;
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

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
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

function insertReplayEvent(events: ReplayEvent[], event: ReplayEvent): void {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const existing = events[mid];
    if (existing !== undefined && existing.timestamp <= event.timestamp) {
      low = mid + 1;
      continue;
    }

    high = mid;
  }

  events.splice(low, 0, event);
}
