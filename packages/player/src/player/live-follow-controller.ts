import { liveSocketUrl, mintLiveTicket } from "../api.ts";
import {
  acceptLiveEventBatchAfterKeyframeWithStatus,
  acceptLiveFrame,
  createLiveFrameState,
  createLiveKeyframeBuffer,
  parseLiveHelloMessage,
  startWaitingForKeyframe,
  stopWaitingForKeyframe,
  type LiveFrame,
  type LiveReplayBatch,
} from "../live.ts";
import type { BatchIndex, LiveSessionSnapshot } from "@orange-replay/shared/types";
import type { OrangePlayerOptions, PlayerErrorEvent, ReplayEvent } from "../types.ts";
import type { DecodeWorkerHost } from "../worker-host.ts";

const LIVE_BASE_RECONNECT_MS = 500;
const LIVE_MAX_RECONNECT_MS = 8_000;

type PlayerErrorSeverity = NonNullable<PlayerErrorEvent["severity"]>;

export interface LiveFollowHost {
  isFollowing(): boolean;
  isDestroyed(): boolean;
  acceptsReplayTab(tab: string, events: readonly ReplayEvent[], keyframeStarted: boolean): boolean;
  onLiveEvents(events: readonly ReplayEvent[]): void;
  onLiveIndex(index: BatchIndex): void;
  onLiveSnapshot(snapshot: LiveSessionSnapshot): void;
  onSessionEnded(): void;
  onResetReplayEvents(): void;
  onReconnectStarted(): void;
  onKeyframeOverflow(): void;
  onSocketOpen(): void;
  onConnectionChanged(connected: boolean): void;
  onWaitingChanged(waiting: boolean): void;
  onError(message: string, error?: unknown, severity?: PlayerErrorSeverity): void;
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
    startWaitingForKeyframe(this.liveKeyframes);
    this.options.host.onConnectionChanged(this.connectedValue);
    this.options.host.onWaitingChanged(this.liveKeyframes.waiting);
  }

  connect(reconnecting = false): void {
    void this.connectWithTicket(reconnecting);
  }

  disconnect(): void {
    this.connectedValue = false;
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

  private async connectWithTicket(reconnecting: boolean): Promise<void> {
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
      if (this.options.host.isDestroyed()) {
        return;
      }
      this.options.host.onError("Could not create a live ticket.", error, "recovering");
      if (this.options.host.isFollowing() && !this.options.host.isDestroyed()) {
        this.scheduleReconnect();
      }
      return;
    }

    if (!this.options.host.isFollowing() || this.options.host.isDestroyed()) {
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
    socket.binaryType = "arraybuffer";
    this.liveSocket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.connectedValue = true;
      this.options.host.onConnectionChanged(this.connectedValue);
      this.options.host.onSocketOpen();
    };

    socket.onmessage = (event) => {
      this.handleLiveMessage(event.data);
    };

    socket.onerror = () => {
      this.options.host.onError("Live socket failed.", undefined, "recovering");
    };

    socket.onclose = (event) => {
      this.connectedValue = false;
      this.options.host.onConnectionChanged(this.connectedValue);
      if (event?.code === 1000) {
        this.options.host.onSessionEnded();
        return;
      }
      if (this.options.host.isFollowing() && !this.options.host.isDestroyed()) {
        this.scheduleReconnect();
      }
    };
  }

  private handleLiveMessage(data: unknown): void {
    if (typeof data === "string") {
      const hello = parseLiveHelloMessage(data);
      if (hello !== null) this.options.host.onLiveSnapshot(hello.snapshot);
      return;
    }
    if (!(data instanceof ArrayBuffer)) {
      return;
    }

    let frame;
    try {
      frame = acceptLiveFrame(this.liveFrames, data);
    } catch (error) {
      this.options.host.onError("Could not read live replay frame.", error, "warning");
      return;
    }

    if (frame !== null) {
      this.options.host.onLiveIndex(frame.index);
      this.queueLiveFrame(frame);
    }
  }

  private queueLiveFrame(frame: LiveFrame): void {
    this.liveDecodeQueue = this.liveDecodeQueue
      .then(() => this.decodeAndApplyLiveFrame(frame))
      .catch((error) => {
        this.options.host.onError("Could not decode live replay frame.", error, "warning");
      });
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
