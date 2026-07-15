import type {
  BatchIndex,
  IndexEvent,
  LiveSessionSnapshot,
  SegmentCheckpoint,
  SegmentRef,
  SessionManifest,
} from "@orange-replay/shared/types";
import type { eventWithTime } from "rrweb";
import type { DeadClick } from "./friction.ts";

export type ReplayEvent = eventWithTime;

export type PlayerApiInput = string | PlayerApi;

export interface PlayerApi {
  baseUrl?: string;
  fetch?: typeof fetch;
  manifestUrl?: (params: SessionRequest) => string;
  segmentUrl?: (params: SegmentRequest) => string;
  liveUrl?: (params: LiveRequest) => string;
  liveTicketUrl?: (params: SessionRequest) => string;
}

export interface SessionRequest {
  projectId: string;
  sessionId: string;
}

export interface SegmentRequest extends SessionRequest {
  segment: SegmentRef;
  segmentName: string;
}

export interface LiveRequest extends SessionRequest {
  ticket: string;
}

export interface LoadSessionOptions extends SessionRequest {
  signal?: AbortSignal;
}

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
    deadClicks: number;
    errors: number;
    rages: number;
    navs: number;
    customs: number;
  };
  deadClicks: DeadClick[];
  sourceEvents: IndexEvent[];
}

export interface InactivityGap {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface SegmentWindow {
  activeIndex: number;
  startIndex: number;
  neededIndexes: number[];
  prefetchIndexes: number[];
  checkpoint?: SegmentCheckpoint & { segmentIndex: number };
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

export interface WaitingKeyframeEvent {
  waiting: boolean;
}

export interface PlayerErrorEvent {
  message: string;
  error?: unknown;
  severity?: "fatal" | "recovering" | "warning";
}

export interface OrangePlayerEventMap {
  ready: SessionManifest;
  timeline: PlayerTimeline;
  progress: ProgressEvent;
  segment: SegmentLoadedEvent;
  buffering: BufferingEvent;
  ended: undefined;
  live: LiveEvent;
  live_index: BatchIndex;
  live_snapshot: LiveSessionSnapshot;
  live_finalized: SessionManifest;
  live_ended: undefined;
  waiting_keyframe: WaitingKeyframeEvent;
  error: PlayerErrorEvent;
}

export type OrangePlayerEventName = keyof OrangePlayerEventMap;
export type OrangePlayerHandler<K extends OrangePlayerEventName> = (
  payload: OrangePlayerEventMap[K],
) => void;
