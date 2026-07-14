import { EventType } from "rrweb";
import { fetchSegmentBytes, liveSocketUrl, mintLiveTicket } from "../api.ts";
import {
  acceptLiveEventBatchAfterKeyframeWithStatus,
  acceptLiveFrame,
  createLiveFrameState,
  createLiveKeyframeBuffer,
  parseLiveFinalizedMessage,
  parseLiveHelloMessage,
  startWaitingForKeyframe,
  stopWaitingForKeyframe,
  type LiveFrame,
  type LiveReplayBatch,
} from "../live.ts";
import {
  chooseSegmentWindow,
  decodeSegmentBatches,
  eventsFromCheckpoint,
  findPrimaryReplayTab,
  mergeReplayEvents,
  validateSegmentCheckpoints,
  type DecodedReplayBatch,
} from "../segments.ts";
import {
  MAX_ACTIVE_REPLAY_DECODED_BYTES,
  MAX_ACTIVE_REPLAY_EVENTS,
} from "./recorded-segment-loader.ts";
import type {
  BatchIndex,
  LiveHelloMessage,
  LiveSessionSnapshot,
  SegmentRef,
  SessionManifest,
} from "@orange-replay/shared/types";
import type { OrangePlayerOptions, PlayerErrorEvent, ReplayEvent } from "../types.ts";
import type { DecodeWorkerHost } from "../worker-host.ts";

const LIVE_BASE_RECONNECT_MS = 500;
const LIVE_MAX_RECONNECT_MS = 8_000;
const LIVE_REVIEW_REFRESH_TIMEOUT_MS = 3_000;

type PlayerErrorSeverity = NonNullable<PlayerErrorEvent["severity"]>;

export interface LiveFollowHost {
  isFollowing(): boolean;
  isDestroyed(): boolean;
  acceptsReplayTab(tab: string, events: readonly ReplayEvent[], keyframeStarted: boolean): boolean;
  onLiveEvents(events: readonly ReplayEvent[]): void;
  onLiveIndex(index: BatchIndex): void;
  onLiveSnapshot(snapshot: LiveSessionSnapshot): void;
  onSessionFinalized(manifest: SessionManifest): void;
  onSessionEnded(): void;
  onResetReplayEvents(): void;
  onReconnectStarted(): void;
  onKeyframeOverflow(): void;
  onSocketOpen(): void;
  onConnectionChanged(connected: boolean): void;
  onWaitingChanged(waiting: boolean): void;
  onError(message: string, error?: unknown, severity?: PlayerErrorSeverity): void;
}

export interface LiveReviewHistory {
  segments: SegmentRef[];
  tailEvents: ReplayEvent[];
}

interface LiveFollowControllerOptions {
  request: Pick<OrangePlayerOptions, "api" | "projectId" | "sessionId" | "token">;
  signal: AbortSignal;
  worker: DecodeWorkerHost;
  host: LiveFollowHost;
}

export class LiveFollowController {
  private readonly options: LiveFollowControllerOptions;
  private readonly liveFrames = createLiveFrameState();
  private readonly liveKeyframes = createLiveKeyframeBuffer();
  private liveDecodeQueue: Promise<void> = Promise.resolve();
  private liveSocket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private connectedValue = false;
  private connectionGeneration = 0;
  private finalMessageReceived = false;
  private historyFramesRemaining = 0;
  private historyReady = true;
  private historyReadyPromise: Promise<void> = Promise.resolve();
  private resolveHistoryReady: (() => void) | undefined;
  private reviewSegments: SegmentRef[] = [];
  private reviewTailEvents: ReplayEvent[] = [];
  private reviewHelloReceived = false;
  private reviewRefreshPending = false;

  constructor(options: LiveFollowControllerOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.connectedValue;
  }

  get waitingForKeyframe(): boolean {
    return this.liveKeyframes.waiting;
  }

  get keyframeStarted(): boolean {
    return this.liveKeyframes.started;
  }

  startFollowing(): void {
    this.connectedValue = false;
    this.finalMessageReceived = false;
    this.historyFramesRemaining = 0;
    this.reviewSegments = [];
    this.reviewTailEvents = [];
    this.reviewHelloReceived = false;
    this.resetHistoryReady();
    startWaitingForKeyframe(this.liveKeyframes);
    this.options.host.onConnectionChanged(this.connectedValue);
    this.options.host.onWaitingChanged(this.liveKeyframes.waiting);
  }

  connect(reconnecting = false): void {
    const generation = ++this.connectionGeneration;
    void this.connectWithTicket(reconnecting, generation);
  }

  waitForHistory(): Promise<void> {
    return this.historyReadyPromise;
  }

  /**
   * Reconnect once before idle review. The new hello contains every segment
   * flushed so far and only the still-pending tail, which keeps long sessions
   * seekable without retaining the whole live stream in browser memory.
   */
  async refreshHistoryForReview(): Promise<void> {
    this.disconnect();
    await this.liveDecodeQueue;
    if (!this.options.host.isFollowing() || this.options.host.isDestroyed()) return;

    this.reviewRefreshPending = true;
    this.startFollowing();
    this.connect();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let refreshTimedOut = false;
    try {
      await Promise.race([
        this.waitForHistory(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            refreshTimedOut = true;
            resolve();
          }, LIVE_REVIEW_REFRESH_TIMEOUT_MS);
        }),
      ]);
      if (refreshTimedOut) {
        this.markHistoryReady();
        this.options.host.onError(
          "Live history refresh took too long. Using replay already received.",
          undefined,
          "warning",
        );
      }
      await this.liveDecodeQueue;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.reviewRefreshPending = false;
    }
  }

  async stopAndTakeReviewHistory(): Promise<LiveReviewHistory> {
    this.disconnect();
    await this.liveDecodeQueue;
    return {
      segments: this.reviewSegments.map(cloneSegment),
      tailEvents: [...this.reviewTailEvents],
    };
  }

  disconnect(): void {
    this.connectionGeneration += 1;
    this.connectedValue = false;
    this.historyFramesRemaining = 0;
    stopWaitingForKeyframe(this.liveKeyframes);

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.liveSocket !== undefined) {
      this.liveSocket.onclose = null;
      this.liveSocket.close();
      this.liveSocket = undefined;
    }

    this.options.host.onConnectionChanged(this.connectedValue);
    this.options.host.onWaitingChanged(this.liveKeyframes.waiting);
  }

  releaseHistoryWait(): void {
    this.markHistoryReady();
  }

  private async connectWithTicket(reconnecting: boolean, generation: number): Promise<void> {
    if (!this.options.host.isFollowing() || this.options.host.isDestroyed()) {
      return;
    }

    if (reconnecting) {
      startWaitingForKeyframe(this.liveKeyframes);
      this.options.host.onReconnectStarted();
      this.options.host.onWaitingChanged(this.liveKeyframes.waiting);
    }

    const token = this.options.request.token;
    if (token === undefined || token.length === 0) {
      this.options.host.onError("Live follow needs an API token.");
      this.markHistoryReady();
      return;
    }

    let ticket: string;
    try {
      const response = await mintLiveTicket(this.options.request.api, {
        projectId: this.options.request.projectId,
        sessionId: this.options.request.sessionId,
        token,
        signal: this.options.signal,
      });
      ticket = response.ticket;
    } catch (error) {
      if (
        generation !== this.connectionGeneration ||
        this.options.host.isDestroyed() ||
        !this.options.host.isFollowing()
      ) {
        return;
      }
      this.options.host.onError(
        "Could not create a live ticket.",
        error,
        this.reviewRefreshPending ? "warning" : "recovering",
      );
      if (this.reviewRefreshPending) {
        this.markHistoryReady();
        return;
      }
      if (this.options.host.isFollowing() && !this.options.host.isDestroyed()) {
        this.scheduleReconnect();
      }
      return;
    }

    if (
      generation !== this.connectionGeneration ||
      !this.options.host.isFollowing() ||
      this.options.host.isDestroyed()
    ) {
      return;
    }

    const socket = new WebSocket(
      liveSocketUrl(this.options.request.api, {
        projectId: this.options.request.projectId,
        sessionId: this.options.request.sessionId,
        token,
        ticket,
      }),
    );
    this.finalMessageReceived = false;
    this.historyFramesRemaining = 0;
    socket.binaryType = "arraybuffer";
    this.liveSocket = socket;

    socket.onopen = () => {
      if (generation !== this.connectionGeneration || this.liveSocket !== socket) return;
      this.reconnectAttempt = 0;
      this.connectedValue = true;
      this.options.host.onConnectionChanged(this.connectedValue);
      this.options.host.onSocketOpen();
    };

    socket.onmessage = (event) => {
      if (generation !== this.connectionGeneration || this.liveSocket !== socket) return;
      this.handleLiveMessage(event.data);
    };

    socket.onerror = () => {
      if (generation !== this.connectionGeneration || this.liveSocket !== socket) return;
      this.options.host.onError("Live socket failed.", undefined, "recovering");
    };

    socket.onclose = (event) => {
      if (generation !== this.connectionGeneration || this.liveSocket !== socket) return;
      this.connectedValue = false;
      this.liveSocket = undefined;
      this.options.host.onConnectionChanged(this.connectedValue);
      if (this.finalMessageReceived) {
        return;
      }
      if (event?.code === 1000) {
        this.markHistoryReady();
        this.options.host.onSessionEnded();
        return;
      }
      if (this.reviewRefreshPending) {
        this.markHistoryReady();
        return;
      }
      if (this.options.host.isFollowing() && !this.options.host.isDestroyed()) {
        this.scheduleReconnect();
      }
    };
  }

  private handleLiveMessage(data: unknown): void {
    if (typeof data === "string") {
      const finalized = parseLiveFinalizedMessage(data);
      if (finalized !== null) {
        this.finalMessageReceived = true;
        this.liveDecodeQueue = this.liveDecodeQueue
          .then(() => {
            if (!this.options.host.isDestroyed()) {
              this.options.host.onSessionFinalized(finalized.manifest);
            }
          })
          .catch((error) => {
            this.options.host.onError(
              "Could not finish the live replay handoff.",
              error,
              "warning",
            );
            this.options.host.onSessionEnded();
          })
          .finally(() => {
            this.markHistoryReady();
          });
        return;
      }

      const hello = parseLiveHelloMessage(data);
      if (hello !== null) {
        const pendingHistoryCount = Math.floor(hello.pendingBatches);
        this.historyFramesRemaining = pendingHistoryCount;
        this.reviewSegments = hello.segments.map(cloneSegment);
        this.reviewTailEvents = [];
        this.reviewHelloReceived = true;
        this.options.host.onLiveSnapshot(hello.snapshot);
        // A reconnect starts from one fresh server snapshot. Let the pending
        // frames that follow hello be accepted again after the replay reset.
        this.liveFrames.seen.clear();
        this.liveDecodeQueue = this.liveDecodeQueue
          .then(() => this.loadHelloReplay(hello))
          .catch((error) => {
            this.options.host.onError(
              "Could not load replay received before the live viewer joined.",
              error,
              "warning",
            );
          })
          .then(() => {
            if (pendingHistoryCount === 0) this.markHistoryReady();
          });
      }
      return;
    }
    if (!(data instanceof ArrayBuffer)) {
      return;
    }

    // The hello snapshot already contains these stored batches. They still
    // need to rebuild the visible replay, but must not increase its counters a
    // second time. New broadcasts arrive after this ordered history prefix.
    const isHistoryFrame = this.historyFramesRemaining > 0;
    const updatesSnapshot = !isHistoryFrame;
    if (isHistoryFrame) {
      this.historyFramesRemaining -= 1;
    }
    const finishesHistory = isHistoryFrame && this.historyFramesRemaining === 0;

    let frame;
    try {
      frame = acceptLiveFrame(this.liveFrames, data);
    } catch (error) {
      this.options.host.onError("Could not read live replay frame.", error, "warning");
      if (finishesHistory) this.queueHistoryReady();
      return;
    }

    if (frame !== null) {
      if (updatesSnapshot) {
        this.options.host.onLiveIndex(frame.index);
      }
      this.queueLiveFrame(frame, finishesHistory);
    } else if (finishesHistory) {
      this.queueHistoryReady();
    }
  }

  private async loadHelloReplay(hello: LiveHelloMessage): Promise<void> {
    if (
      hello.segments.length === 0 ||
      !this.options.host.isFollowing() ||
      this.options.host.isDestroyed()
    ) {
      return;
    }

    const lastSegmentIndex = hello.segments.length - 1;
    const lastSegment = hello.segments[lastSegmentIndex];
    if (lastSegment === undefined) {
      return;
    }

    const replayTab = findPrimaryReplayTab(hello.segments);
    const window = chooseSegmentWindow(hello.segments, lastSegmentIndex, {
      targetTimestamp: lastSegment.t1,
      replayTab,
    });
    const batches: DecodedReplayBatch[] = [];
    let eventCount = 0;
    let decodedBytes = 0;

    for (const segmentIndex of window.neededIndexes) {
      const segment = hello.segments[segmentIndex];
      if (segment === undefined) continue;

      const bytes = await fetchSegmentBytes(this.options.request.api, {
        projectId: this.options.request.projectId,
        sessionId: this.options.request.sessionId,
        token: this.options.request.token,
        segment,
        signal: this.options.signal,
      });
      const decoded = await decodeSegmentBatches(bytes, this.options.worker);
      validateSegmentCheckpoints(segment, decoded);
      for (const batch of decoded) {
        eventCount += batch.events.length;
        decodedBytes += batch.decodedBytes;
        if (eventCount > MAX_ACTIVE_REPLAY_EVENTS) {
          throw new Error("Live replay history has too many events to load safely.");
        }
        if (decodedBytes > MAX_ACTIVE_REPLAY_DECODED_BYTES) {
          throw new Error("Live replay history is too large after decoding.");
        }
      }
      batches.push(...decoded);
    }

    if (!this.options.host.isFollowing() || this.options.host.isDestroyed()) {
      return;
    }

    const activeTab =
      window.checkpoint?.tab ?? replayTab ?? firstFullSnapshotTab(batches) ?? batches[0]?.index.tab;
    if (activeTab === undefined) {
      return;
    }

    let events = mergeReplayEvents(
      batches.filter((batch) => batch.index.tab === activeTab).flatMap((batch) => batch.events),
    );
    if (window.checkpoint !== undefined) {
      events = eventsFromCheckpoint(events, window.checkpoint.timestamp);
    }
    if (!events.some((event) => event.type === EventType.FullSnapshot)) {
      return;
    }

    this.options.host.onResetReplayEvents();
    if (!this.options.host.acceptsReplayTab(activeTab, events, false)) {
      return;
    }
    this.liveKeyframes.waiting = false;
    this.liveKeyframes.started = true;
    this.liveKeyframes.events = [];
    this.liveKeyframes.batches = [];
    this.liveKeyframes.estimatedBytes = 0;
    this.liveKeyframes.waitingStartedAt = 0;
    this.options.host.onWaitingChanged(false);
    this.options.host.onLiveEvents(events);
  }

  private queueLiveFrame(frame: LiveFrame, finishesHistory = false): void {
    this.liveDecodeQueue = this.liveDecodeQueue
      .then(() => this.decodeAndApplyLiveFrame(frame))
      .catch((error) => {
        this.options.host.onError("Could not decode live replay frame.", error, "warning");
      })
      .then(() => {
        if (finishesHistory) this.markHistoryReady();
      });
  }

  private queueHistoryReady(): void {
    this.liveDecodeQueue = this.liveDecodeQueue.then(() => this.markHistoryReady());
  }

  private resetHistoryReady(): void {
    this.historyReady = false;
    this.historyReadyPromise = new Promise((resolve) => {
      this.resolveHistoryReady = resolve;
    });
  }

  private markHistoryReady(): void {
    if (this.historyReady) return;
    this.historyReady = true;
    this.resolveHistoryReady?.();
    this.resolveHistoryReady = undefined;
  }

  private async decodeAndApplyLiveFrame(frame: LiveFrame): Promise<void> {
    if (!this.options.host.isFollowing() || this.options.host.isDestroyed()) {
      return;
    }

    const events = await this.options.worker.decodeBatch(frame.payload);
    if (
      !this.options.host.isFollowing() ||
      this.options.host.isDestroyed() ||
      !this.options.host.acceptsReplayTab(frame.index.tab, events, this.liveKeyframes.started)
    ) {
      return;
    }

    const acceptedEvents = this.acceptLiveReplayEvents({
      tab: frame.index.tab,
      seq: frame.index.seq,
      events,
    });
    if (acceptedEvents.length > 0) {
      if (this.reviewHelloReceived) this.reviewTailEvents.push(...acceptedEvents);
      this.options.host.onLiveEvents(acceptedEvents);
    }
  }

  private acceptLiveReplayEvents(batch: LiveReplayBatch): ReplayEvent[] {
    if (!this.options.host.isFollowing() || this.liveKeyframes.started) {
      return [...batch.events];
    }

    const wasWaiting = this.liveKeyframes.waiting;
    const result = acceptLiveEventBatchAfterKeyframeWithStatus(this.liveKeyframes, batch);
    if (wasWaiting !== this.liveKeyframes.waiting) {
      this.options.host.onWaitingChanged(this.liveKeyframes.waiting);
    }
    if (result.status === "overflow") {
      this.reconnectAfterKeyframeOverflow();
      return [];
    }

    if (wasWaiting && result.status === "accepted") {
      this.options.host.onResetReplayEvents();
    }

    return result.events;
  }

  private reconnectAfterKeyframeOverflow(): void {
    if (!this.options.host.isFollowing() || this.options.host.isDestroyed()) {
      return;
    }

    this.options.host.onKeyframeOverflow();
    this.connectedValue = false;
    if (this.liveSocket !== undefined) {
      this.liveSocket.onclose = null;
      this.liveSocket.close();
      this.liveSocket = undefined;
    }
    this.options.host.onConnectionChanged(this.connectedValue);
    this.options.host.onWaitingChanged(this.liveKeyframes.waiting);
    this.options.host.onError(
      "Live replay waited too long for a keyframe.",
      undefined,
      "recovering",
    );
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
    }

    const delay = Math.min(
      LIVE_MAX_RECONNECT_MS,
      LIVE_BASE_RECONNECT_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(true);
    }, delay);
  }
}

function firstFullSnapshotTab(batches: readonly DecodedReplayBatch[]): string | undefined {
  return batches.find((batch) =>
    batch.events.some((event) => event.type === EventType.FullSnapshot),
  )?.index.tab;
}

function cloneSegment(segment: SegmentRef): SegmentRef {
  return {
    ...segment,
    ...(segment.checkpoints === undefined
      ? {}
      : { checkpoints: segment.checkpoints.map((checkpoint) => ({ ...checkpoint })) }),
  };
}
