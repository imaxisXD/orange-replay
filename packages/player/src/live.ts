import { decodeIngestBody } from "@orange-replay/shared/wire";
import type { BatchIndex } from "@orange-replay/shared/types";

export interface LiveFrame {
  index: BatchIndex;
  payload: Uint8Array;
}

export interface LiveFrameState {
  seen: Set<string>;
  frames: LiveFrame[];
}

export function createLiveFrameState(): LiveFrameState {
  return {
    seen: new Set(),
    frames: [],
  };
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
