import { decodeIngestBody } from "@orange-replay/shared/wire";
import type { BatchIndex } from "@orange-replay/shared/types";
import { EventType } from "rrweb";
import type { ReplayEvent } from "./types.ts";

export interface LiveFrame {
  index: BatchIndex;
  payload: Uint8Array;
}

export interface LiveFrameState {
  seen: Set<string>;
  frames: LiveFrame[];
}

export interface LiveKeyframeBuffer {
  waiting: boolean;
  started: boolean;
  events: ReplayEvent[];
}

export function createLiveFrameState(): LiveFrameState {
  return {
    seen: new Set(),
    frames: [],
  };
}

export function createLiveKeyframeBuffer(): LiveKeyframeBuffer {
  return {
    waiting: false,
    started: false,
    events: [],
  };
}

export function startWaitingForKeyframe(buffer: LiveKeyframeBuffer): void {
  buffer.waiting = true;
  buffer.started = false;
  buffer.events = [];
}

export function stopWaitingForKeyframe(buffer: LiveKeyframeBuffer): void {
  buffer.waiting = false;
  buffer.started = false;
  buffer.events = [];
}

export function acceptLiveEventsAfterKeyframe(
  buffer: LiveKeyframeBuffer,
  events: readonly ReplayEvent[],
): ReplayEvent[] {
  if (!buffer.waiting || buffer.started) {
    return [...events];
  }

  buffer.events.push(...events);
  const snapshotIndex = buffer.events.findIndex(isFullSnapshotEvent);
  if (snapshotIndex < 0) {
    return [];
  }

  const startIndex =
    snapshotIndex > 0 && isMetaEvent(buffer.events[snapshotIndex - 1])
      ? snapshotIndex - 1
      : snapshotIndex;
  const acceptedEvents = buffer.events.slice(startIndex);
  buffer.events = [];
  buffer.started = true;
  buffer.waiting = false;
  return acceptedEvents;
}

export function acceptLiveFrame(
  state: LiveFrameState,
  bytes: ArrayBuffer | Uint8Array,
): LiveFrame | null {
  const frame = decodeLiveFrame(bytes);
  const key = liveFrameKey(frame.index);

  if (state.seen.has(key)) {
    return null;
  }

  state.seen.add(key);
  state.frames.push(frame);
  state.frames.sort(compareLiveFrames);
  return frame;
}

export function decodeLiveFrame(bytes: ArrayBuffer | Uint8Array): LiveFrame {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return decodeIngestBody(view);
}

export function orderLiveFrames(frames: readonly LiveFrame[]): LiveFrame[] {
  const seen = new Set<string>();
  const ordered: LiveFrame[] = [];

  for (const frame of frames) {
    const key = liveFrameKey(frame.index);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    ordered.push(frame);
  }

  return ordered.sort(compareLiveFrames);
}

export function liveFrameKey(index: BatchIndex): string {
  return `${index.tab}:${index.seq}`;
}

function compareLiveFrames(left: LiveFrame, right: LiveFrame): number {
  const tabOrder = left.index.tab.localeCompare(right.index.tab);
  if (tabOrder !== 0) {
    return tabOrder;
  }

  return left.index.seq - right.index.seq;
}

function isFullSnapshotEvent(event: ReplayEvent): boolean {
  return event.type === EventType.FullSnapshot;
}

function isMetaEvent(event: ReplayEvent | undefined): boolean {
  return event?.type === EventType.Meta;
}
