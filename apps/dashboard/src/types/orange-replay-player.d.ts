declare module "@orange-replay/player" {
  import type { SegmentRef, SessionManifest } from "@orange-replay/shared/types";

  export type PlayerApiInput = string | PlayerApi;

  export interface PlayerApi {
    baseUrl?: string;
    fetch?: typeof fetch;
    manifestUrl?: (params: SessionRequest) => string;
    segmentUrl?: (params: SegmentRequest) => string;
    liveUrl?: (params: LiveRequest) => string;
  }

  export interface SessionRequest {
    projectId: string;
    sessionId: string;
    token?: string;
  }

  export interface SegmentRequest extends SessionRequest {
    segment: SegmentRef;
    segmentName: string;
  }

  export interface LiveRequest extends SessionRequest {
    token: string;
  }

  export interface OverlayOptions {
    cursorColor?: string;
    cursorOpacity?: number;
    clickColor?: string;
    clickOpacity?: number;
    rageColor?: string;
    rageOpacity?: number;
    trailMs?: number;
  }

  export interface OrangePlayerOptions extends SessionRequest {
    api: PlayerApiInput;
    speed?: number;
    skipInactivity?: boolean;
    overlay?: OverlayOptions;
  }

  export interface SegmentLoadedEvent {
    index: number;
    segment: SegmentRef;
    eventCount: number;
  }

  export interface BufferingEvent {
    buffering: boolean;
    segmentIndex?: number;
  }

  export interface ProgressEvent {
    currentMs: number;
    durationMs: number;
  }

  export interface LiveEvent {
    following: boolean;
    connected: boolean;
  }

  export interface WaitingKeyframeEvent {
    waiting: boolean;
  }

  export interface PlayerErrorEvent {
    message: string;
    error?: unknown;
  }

  export interface PlayerTimeline {
    durationMs: number;
  }

  export interface OrangePlayerEventMap {
    ready: SessionManifest;
    timeline: PlayerTimeline;
    progress: ProgressEvent;
    segment: SegmentLoadedEvent;
    buffering: BufferingEvent;
    ended: undefined;
    live: LiveEvent;
    waiting_keyframe: WaitingKeyframeEvent;
    error: PlayerErrorEvent;
  }

  export type OrangePlayerEventName = keyof OrangePlayerEventMap;
  export type OrangePlayerHandler<K extends OrangePlayerEventName> = (
    payload: OrangePlayerEventMap[K],
  ) => void;

  export class OrangePlayer {
    constructor(container: HTMLElement, options: OrangePlayerOptions);
    on<K extends OrangePlayerEventName>(name: K, handler: OrangePlayerHandler<K>): () => void;
    off<K extends OrangePlayerEventName>(name: K, handler: OrangePlayerHandler<K>): void;
    ready(): Promise<SessionManifest>;
    play(): Promise<void>;
    pause(): void;
    seek(ms: number): Promise<void>;
    setSpeed(value: number): void;
    setSkipInactivity(value: boolean): void;
    follow(): void;
    destroy(): void;
  }
}
