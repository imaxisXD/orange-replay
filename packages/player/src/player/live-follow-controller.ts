import { EventType } from "rrweb";
import { fetchSegmentBytes, liveSocketUrl, mintLiveTicket } from "../api.ts";
import {
  acceptLiveEventBatchAfterKeyframeWithStatus,
  acceptLiveFrame,
  createLiveFrameState,
  createLiveKeyframeBuffer,
  parseLiveFinalizedMessage,
  parseLiveHelloMessage,
  retainLiveReplayEvents,
  startWaitingForKeyframe,
  stopWaitingForKeyframe,
  type LiveFrame,
  type LiveReplayBatch,
} from "../live.ts";
import {
  chooseSegmentWindow,
  createReplayHistoryDecodeState,
  decodeReplayHistorySegment,
  eventsFromCheckpoint,
  findPrimaryReplayTab,
  mergeReplayEvents,
  validateSegmentCheckpoints,
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
import { isReplayDataError } from "../worker-core.ts";
import { validateReplayEventTimesAgainstIndex } from "../replay-event-validation.ts";

const LIVE_BASE_RECONNECT_MS = 500;
const LIVE_MAX_RECONNECT_MS = 8_000;
const LIVE_REVIEW_REFRESH_TIMEOUT_MS = 3_000;
const LIVE_REVIEW_TAIL_MS = 5 * 60_000;
const MAX_LIVE_QUEUED_ENCODED_BYTES = 16 * 1024 * 1024;

type PlayerErrorSeverity = NonNullable<PlayerErrorEvent["severity"]>;

export type LiveFollowEvent =
  | { type: "connection"; connected: boolean }
  | { type: "ended" }
  | { type: "error"; message: string; error?: unknown; severity?: PlayerErrorSeverity }
  | { type: "events"; events: readonly ReplayEvent[] }
  | { type: "finalized"; manifest: SessionManifest }
  | { type: "index"; index: BatchIndex }
  | { type: "keyframe_overflow" }
  | { type: "open" }
  | { type: "reconnect" }
  | { type: "reset" }
  | { type: "snapshot"; snapshot: LiveSessionSnapshot }
  | { type: "waiting"; waiting: boolean };

export interface LiveFollowHost {
  acceptsReplayTab(tab: string, events: readonly ReplayEvent[], keyframeStarted: boolean): boolean;
  onEvent(event: LiveFollowEvent): void;
}

export interface LiveReviewHistory {
  segments: SegmentRef[];
  tailEvents: ReplayEvent[];
}

interface LiveFollowControllerOptions {
  request: Pick<OrangePlayerOptions, "api" | "projectId" | "sessionId">;
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
  private active = false;
  private activeEventCount = 0;
  private activeDecodedBytes = 0;
  private queuedEncodedBytes = 0;

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
    this.active = true;
    this.connectedValue = false;
    this.finalMessageReceived = false;
    this.historyFramesRemaining = 0;
    this.reviewSegments = [];
    this.reviewTailEvents = [];
    this.reviewHelloReceived = false;
    this.activeEventCount = 0;
    this.activeDecodedBytes = 0;
    this.resetHistoryReady();
    startWaitingForKeyframe(this.liveKeyframes);
    this.emit({ type: "connection", connected: this.connectedValue });
    this.emit({ type: "waiting", waiting: this.liveKeyframes.waiting });
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
    this.closeConnection();
    await this.liveDecodeQueue;
    if (this.isStopped()) return;

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
        this.emit({
          type: "error",
          message: "Live history refresh took too long. Using replay already received.",
          severity: "warning",
        });
      }
      await this.liveDecodeQueue;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.reviewRefreshPending = false;
    }
  }

  async stopAndTakeReviewHistory(): Promise<LiveReviewHistory> {
    this.closeConnection(false);
    await this.liveDecodeQueue;
    this.connectionGeneration += 1;
    this.active = false;
    return {
      segments: this.reviewSegments.map(cloneSegment),
      tailEvents: [...this.reviewTailEvents],
    };
  }

  stopFollowing(): void {
    this.active = false;
    this.closeConnection();
  }

  private closeConnection(invalidateQueuedFrames = true): void {
    if (invalidateQueuedFrames) this.connectionGeneration += 1;
    this.connectedValue = false;
    this.historyFramesRemaining = 0;
    stopWaitingForKeyframe(this.liveKeyframes);

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.liveSocket !== undefined) {
      this.liveSocket.onclose = null;
      this.liveSocket.onmessage = null;
      this.liveSocket.close();
      this.liveSocket = undefined;
    }

    this.emit({ type: "connection", connected: this.connectedValue });
    this.emit({ type: "waiting", waiting: this.liveKeyframes.waiting });
  }

  releaseHistoryWait(): void {
    this.markHistoryReady();
  }

  private async connectWithTicket(reconnecting: boolean, generation: number): Promise<void> {
    if (this.isStopped()) {
      return;
    }

    if (reconnecting) {
      startWaitingForKeyframe(this.liveKeyframes);
      this.activeEventCount = 0;
      this.activeDecodedBytes = 0;
      this.emit({ type: "reconnect" });
      this.emit({ type: "waiting", waiting: this.liveKeyframes.waiting });
    }

    let ticket: string;
    try {
      const response = await mintLiveTicket(this.options.request.api, {
        projectId: this.options.request.projectId,
        sessionId: this.options.request.sessionId,
        signal: this.options.signal,
      });
      ticket = response.ticket;
    } catch (error) {
      if (generation !== this.connectionGeneration || this.isStopped()) {
        return;
      }
      this.emit({
        type: "error",
        message: "Could not create a live ticket.",
        error,
        severity: this.reviewRefreshPending ? "warning" : "recovering",
      });
      if (this.reviewRefreshPending) {
        this.markHistoryReady();
        return;
      }
      if (!this.isStopped()) {
        this.scheduleReconnect();
      }
      return;
    }

    if (generation !== this.connectionGeneration || this.isStopped()) {
      return;
    }

    const socket = new WebSocket(
      liveSocketUrl(this.options.request.api, {
        projectId: this.options.request.projectId,
        sessionId: this.options.request.sessionId,
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
      this.emit({ type: "connection", connected: this.connectedValue });
      this.emit({ type: "open" });
    };

    socket.onmessage = (event) => {
      if (generation !== this.connectionGeneration || this.liveSocket !== socket) return;
      this.handleLiveMessage(event.data, generation);
    };

    socket.onerror = () => {
      if (generation !== this.connectionGeneration || this.liveSocket !== socket) return;
      this.emit({ type: "error", message: "Live socket failed.", severity: "recovering" });
    };

    socket.onclose = (event) => {
      if (generation !== this.connectionGeneration || this.liveSocket !== socket) return;
      this.connectedValue = false;
      this.liveSocket = undefined;
      this.emit({ type: "connection", connected: this.connectedValue });
      if (this.finalMessageReceived) {
        return;
      }
      if (event?.code === 1000) {
        this.markHistoryReady();
        this.emit({ type: "ended" });
        return;
      }
      if (this.reviewRefreshPending) {
        this.markHistoryReady();
        return;
      }
      if (!this.isStopped()) {
        this.scheduleReconnect();
      }
    };
  }

  private handleLiveMessage(data: unknown, generation: number): void {
    if (typeof data === "string") {
      const finalized = parseLiveFinalizedMessage(data);
      if (finalized !== null) {
        this.finalMessageReceived = true;
        this.liveDecodeQueue = this.liveDecodeQueue
          .then(() => {
            if (!this.options.signal.aborted) {
              this.emit({ type: "finalized", manifest: finalized.manifest });
            }
          })
          .catch((error) => {
            this.emit({
              type: "error",
              message: "Could not finish the live replay handoff.",
              error,
              severity: "warning",
            });
            this.emit({ type: "ended" });
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
        this.emit({ type: "snapshot", snapshot: hello.snapshot });
        // A reconnect starts from one fresh server snapshot. Let the pending
        // frames that follow hello be accepted again after the replay reset.
        this.liveFrames.seen.clear();
        this.liveDecodeQueue = this.liveDecodeQueue
          .then(() => this.loadHelloReplay(hello))
          .catch((error) => {
            this.emit({
              type: "error",
              message: isReplayDataError(error)
                ? "This live recording contains an unreadable replay event. Waiting for newer data."
                : "Could not load replay received before the live viewer joined.",
              error,
              severity: "warning",
            });
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
      this.emit({
        type: "error",
        message: "Could not read live replay frame.",
        error,
        severity: "warning",
      });
      if (finishesHistory) this.queueHistoryReady();
      return;
    }

    if (frame !== null) {
      if (updatesSnapshot) {
        this.emit({ type: "index", index: frame.index });
      }
      this.queueLiveFrame(frame, generation, finishesHistory);
    } else if (finishesHistory) {
      this.queueHistoryReady();
    }
  }

  private async loadHelloReplay(hello: LiveHelloMessage): Promise<void> {
    if (hello.segments.length === 0 || this.isStopped()) {
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
    const decodeState = createReplayHistoryDecodeState(window.checkpoint?.tab ?? replayTab);

    for (const segmentIndex of window.neededIndexes) {
      const segment = hello.segments[segmentIndex];
      if (segment === undefined) continue;

      const bytes = await fetchSegmentBytes(this.options.request.api, {
        projectId: this.options.request.projectId,
        sessionId: this.options.request.sessionId,
        segment,
        signal: this.options.signal,
      });
      const decoded = await decodeReplayHistorySegment(
        bytes,
        this.options.worker,
        decodeState,
        segment,
      );
      validateSegmentCheckpoints(segment, decoded, decodeState.activeTab);
    }

    if (this.isStopped()) {
      return;
    }

    const activeTab = decodeState.activeTab;
    if (activeTab === undefined) {
      return;
    }

    let events = mergeReplayEvents(decodeState.batches.flatMap((batch) => batch.events));
    if (window.checkpoint !== undefined) {
      events = eventsFromCheckpoint(events, window.checkpoint.timestamp);
    }
    if (!events.some((event) => event.type === EventType.FullSnapshot)) {
      return;
    }

    this.emit({ type: "reset" });
    if (!this.options.host.acceptsReplayTab(activeTab, events, false)) {
      return;
    }
    this.liveKeyframes.waiting = false;
    this.liveKeyframes.started = true;
    this.liveKeyframes.events = [];
    this.liveKeyframes.batches = [];
    this.liveKeyframes.estimatedBytes = 0;
    this.liveKeyframes.waitingStartedAt = 0;
    this.activeEventCount = events.length;
    this.activeDecodedBytes = decodeState.activeDecodedBytes;
    this.emit({ type: "waiting", waiting: false });
    this.emit({ type: "events", events });
  }

  private queueLiveFrame(frame: LiveFrame, generation: number, finishesHistory = false): void {
    const encodedBytes = frame.encodedByteLength;
    if (this.queuedEncodedBytes + encodedBytes > MAX_LIVE_QUEUED_ENCODED_BYTES) {
      this.reconnectAfterLiveBudgetOverflow("Live replay arrived faster than it could be decoded.");
      if (finishesHistory) this.queueHistoryReady();
      return;
    }
    this.queuedEncodedBytes += encodedBytes;
    this.liveDecodeQueue = this.liveDecodeQueue
      .then(() => this.decodeAndApplyLiveFrame(frame, generation))
      .catch((error) => {
        this.emit({
          type: "error",
          message: isReplayDataError(error)
            ? "This live recording contains an unreadable replay event. Waiting for newer data."
            : "Could not decode live replay frame.",
          error,
          severity: "warning",
        });
      })
      .finally(() => {
        this.queuedEncodedBytes = Math.max(0, this.queuedEncodedBytes - encodedBytes);
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

  private async decodeAndApplyLiveFrame(frame: LiveFrame, generation: number): Promise<void> {
    if (this.isStopped()) {
      return;
    }

    const decoded = await this.options.worker.decodeBatchWithStats(frame.payload);
    const events = decoded.events;
    validateReplayEventTimesAgainstIndex(events, frame.index);
    if (
      this.isStopped() ||
      generation !== this.connectionGeneration ||
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
      if (
        this.activeEventCount + acceptedEvents.length > MAX_ACTIVE_REPLAY_EVENTS ||
        this.activeDecodedBytes + decoded.decodedBytes > MAX_ACTIVE_REPLAY_DECODED_BYTES
      ) {
        this.reconnectAfterLiveBudgetOverflow("Live replay became too large to keep open safely.");
        return;
      }
      this.activeEventCount += acceptedEvents.length;
      this.activeDecodedBytes += decoded.decodedBytes;
      if (this.reviewHelloReceived) {
        const tail = [...this.reviewTailEvents, ...acceptedEvents];
        const newestTimestamp = tail.at(-1)?.timestamp ?? 0;
        this.reviewTailEvents = retainLiveReplayEvents(tail, newestTimestamp - LIVE_REVIEW_TAIL_MS);
      }
      this.emit({ type: "events", events: acceptedEvents });
    }
  }

  private acceptLiveReplayEvents(batch: LiveReplayBatch): ReplayEvent[] {
    if (this.isStopped()) {
      return [];
    }
    if (this.liveKeyframes.started) {
      return [...batch.events];
    }

    const wasWaiting = this.liveKeyframes.waiting;
    const result = acceptLiveEventBatchAfterKeyframeWithStatus(this.liveKeyframes, batch);
    if (wasWaiting !== this.liveKeyframes.waiting) {
      this.emit({ type: "waiting", waiting: this.liveKeyframes.waiting });
    }
    if (result.status === "overflow") {
      this.reconnectAfterKeyframeOverflow();
      return [];
    }

    if (wasWaiting && result.status === "accepted") {
      this.emit({ type: "reset" });
    }

    return result.events;
  }

  private reconnectAfterKeyframeOverflow(): void {
    if (this.isStopped()) {
      return;
    }

    this.emit({ type: "keyframe_overflow" });
    this.connectionGeneration += 1;
    this.connectedValue = false;
    if (this.liveSocket !== undefined) {
      this.liveSocket.onclose = null;
      this.liveSocket.close();
      this.liveSocket = undefined;
    }
    this.emit({ type: "connection", connected: this.connectedValue });
    this.emit({ type: "waiting", waiting: this.liveKeyframes.waiting });
    this.emit({
      type: "error",
      message: "Live replay waited too long for a keyframe.",
      severity: "recovering",
    });
    this.scheduleReconnect();
  }

  private reconnectAfterLiveBudgetOverflow(message: string): void {
    if (this.isStopped()) return;
    this.connectionGeneration += 1;
    this.activeEventCount = 0;
    this.activeDecodedBytes = 0;
    startWaitingForKeyframe(this.liveKeyframes);
    this.emit({ type: "reset" });
    this.emit({ type: "keyframe_overflow" });
    this.connectedValue = false;
    if (this.liveSocket !== undefined) {
      this.liveSocket.onclose = null;
      this.liveSocket.close();
      this.liveSocket = undefined;
    }
    this.emit({ type: "connection", connected: false });
    this.emit({ type: "waiting", waiting: true });
    this.emit({ type: "error", message, severity: "recovering" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.isStopped()) {
      return;
    }
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
      if (!this.isStopped()) this.connect(true);
    }, delay);
  }

  private isStopped(): boolean {
    return !this.active || this.options.signal.aborted;
  }

  private emit(event: LiveFollowEvent): void {
    if (!this.options.signal.aborted) {
      this.options.host.onEvent(event);
    }
  }
}

export function retainedDecodedBytesForTab(
  batches: readonly { decodedBytes: number; index: Pick<BatchIndex, "tab"> }[],
  activeTab: string,
): number {
  return batches.reduce(
    (total, batch) => total + (batch.index.tab === activeTab ? batch.decodedBytes : 0),
    0,
  );
}

function cloneSegment(segment: SegmentRef): SegmentRef {
  return {
    ...segment,
    ...(segment.checkpoints === undefined
      ? {}
      : { checkpoints: segment.checkpoints.map((checkpoint) => ({ ...checkpoint })) }),
  };
}
