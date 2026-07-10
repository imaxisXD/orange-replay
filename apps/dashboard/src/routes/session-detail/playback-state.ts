import type { DeadClick, LiveEvent, PlayerErrorEvent } from "@orange-replay/player";
import type { ReplayMode } from "./session-detail-data";

export interface PlaybackState {
  ready: boolean;
  buffering: boolean;
  playing: boolean;
  currentMs: number;
  durationMs: number;
  speed: number;
  skipIdle: boolean;
  playerError: PlayerErrorEvent | null;
  liveState: LiveEvent;
  waitingForKeyframe: boolean;
  flashKey: number;
  deadClicks: DeadClick[];
}

export type PlaybackAction =
  | { type: "ready"; durationMs: number }
  | { type: "timeline"; durationMs: number; deadClicks: DeadClick[] }
  | { type: "progress"; currentMs: number; durationMs: number }
  | { type: "buffering"; buffering: boolean }
  | { type: "playing"; playing: boolean }
  | { type: "seek"; timeMs: number; flash: boolean }
  | { type: "speed"; speed: number }
  | { type: "skipIdle" }
  | { type: "retry" }
  | { type: "error"; error: PlayerErrorEvent | null }
  | { type: "live"; liveState: LiveEvent }
  | { type: "waitingKeyframe"; waiting: boolean };

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case "ready": {
      if (state.ready && state.durationMs === action.durationMs && !state.buffering) return state;
      return { ...state, ready: true, durationMs: action.durationMs, buffering: false };
    }
    case "timeline":
      if (
        state.durationMs === action.durationMs &&
        sameDeadClicks(state.deadClicks, action.deadClicks)
      ) {
        return state;
      }
      return { ...state, durationMs: action.durationMs, deadClicks: action.deadClicks };
    case "progress":
      if (state.currentMs === action.currentMs && state.durationMs === action.durationMs)
        return state;
      return { ...state, currentMs: action.currentMs, durationMs: action.durationMs };
    case "buffering":
      if (state.buffering === action.buffering) return state;
      return { ...state, buffering: action.buffering };
    case "playing":
      if (state.playing === action.playing) return state;
      return { ...state, playing: action.playing };
    case "seek":
      if (state.currentMs === action.timeMs && !action.flash) return state;
      return {
        ...state,
        currentMs: action.timeMs,
        flashKey: action.flash ? state.flashKey + 1 : state.flashKey,
      };
    case "speed":
      if (state.speed === action.speed) return state;
      return { ...state, speed: action.speed };
    case "skipIdle":
      return { ...state, skipIdle: !state.skipIdle };
    case "retry":
      return {
        ...state,
        ready: false,
        buffering: false,
        playing: false,
        currentMs: 0,
        playerError: null,
        waitingForKeyframe: state.liveState.following,
      };
    case "error": {
      const nextBuffering = action.error ? false : state.buffering;
      if (state.playerError === action.error && state.buffering === nextBuffering) return state;
      return {
        ...state,
        playerError: action.error,
        buffering: nextBuffering,
      };
    }
    case "live":
      if (
        state.liveState.following === action.liveState.following &&
        state.liveState.connected === action.liveState.connected
      ) {
        return state;
      }
      return { ...state, liveState: action.liveState };
    case "waitingKeyframe":
      if (state.waitingForKeyframe === action.waiting) return state;
      return { ...state, waitingForKeyframe: action.waiting };
  }
}

export function initialPlaybackState(durationMs: number, mode: ReplayMode): PlaybackState {
  return {
    ready: false,
    buffering: false,
    playing: false,
    currentMs: 0,
    durationMs,
    speed: 1,
    skipIdle: false,
    playerError: null,
    liveState: { following: mode === "live", connected: false },
    waitingForKeyframe: mode === "live",
    flashKey: 0,
    deadClicks: [],
  };
}

function sameDeadClicks(left: readonly DeadClick[], right: readonly DeadClick[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (click, index) => click.t === right[index]?.t && click.detail === right[index]?.detail,
    )
  );
}
