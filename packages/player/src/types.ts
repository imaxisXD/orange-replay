import type { IndexEvent, SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import type { eventWithTime } from "rrweb";

export type ReplayEvent = eventWithTime;

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

export interface LoadSessionOptions extends SessionRequest {}

export interface TimelineTick {
  timeMs: number;
  count: number;
}

export type TimelineMarkerKind = "click" | "rage" | "error" | "nav" | "custom";

export interface TimelineMarker {
  timeMs: number;
  kind: TimelineMarkerKind;
  label?: string;
  meta?: Record<string, string | number>;
}

export interface PlayerTimeline {
  durationMs: number;
  ticks: TimelineTick[];
  markers: TimelineMarker[];
  counts: {
    clicks: number;
    errors: number;
    rages: number;
    navs: number;
    customs: number;
  };
  sourceEvents: IndexEvent[];
}

export interface InactivityGap {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface SegmentWindow {
  activeIndex: number;
  neededIndexes: number[];
  prefetchIndexes: number[];
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
  worker?: DecodeWorkerOptions;
}

export interface DecodeWorkerOptions {
  WorkerCtor?: typeof Worker;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  timeoutMs?: number;
  allowSynchronousFallback?: boolean;
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

export interface PlayerErrorEvent {
  message: string;
  error?: unknown;
}

export interface OrangePlayerEventMap {
  ready: SessionManifest;
  timeline: PlayerTimeline;
  progress: ProgressEvent;
  segment: SegmentLoadedEvent;
  buffering: BufferingEvent;
  ended: undefined;
  live: LiveEvent;
  error: PlayerErrorEvent;
}

export type OrangePlayerEventName = keyof OrangePlayerEventMap;
export type OrangePlayerHandler<K extends OrangePlayerEventName> = (
  payload: OrangePlayerEventMap[K],
) => void;
