import {
  useEffect,
  useEffectEvent,
  useReducer,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { OrangePlayer } from "@orange-replay/player";
import type { SessionManifest } from "@orange-replay/shared/types";
import { getApiToken } from "@/lib/api";
import {
  getPlayerKeyAction,
  timelineProgressPercent,
  timelineXToTime,
} from "@/lib/replay-timeline";
import type { ReplayMode } from "./session-detail-data";
import {
  clampTime,
  dashboardPlayerApi,
  readReplayOverlayColors,
  readErrorMessage,
} from "./replay-player-runtime";
import { initialPlaybackState, playbackReducer, type PlaybackState } from "./playback-state";

export type { PlaybackState } from "./playback-state";

export interface ReplayPlayerOptions {
  isDemo: boolean;
  manifest: SessionManifest;
  mode: ReplayMode;
  projectId: string;
  sessionId: string;
}

export interface ReplayPlayerState {
  containerRef: React.RefObject<HTMLDivElement | null>;
  state: PlaybackState;
  values: {
    isFollowing: boolean;
    playheadPercent: number;
    timelineDurationMs: number;
  };
  actions: {
    cycleSpeed: () => void;
    retryPlayer: () => void;
    seekFromPointer: (event: ReactPointerEvent<HTMLDivElement>) => void;
    seekTo: (timeMs: number, flash?: boolean) => void;
    stopTimelineDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
    startTimelineDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
    moveTimelineDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
    togglePlayback: () => void;
    toggleSkipIdle: () => void;
  };
}

export interface ReplayPlayerController {
  seekTo: (timeMs: number, flash?: boolean) => void;
}

// OrangePlayer currently uses a non-empty token as the signal that live
// follow is allowed. Demo routes are allowed to mint tickets without bearer
// auth, so this marker stays inside the player and is removed before fetch.
const demoPlayerAccessMarker = "demo-read-only";

export function useReplayPlayer({
  manifest,
  isDemo,
  mode,
  projectId,
  sessionId,
}: ReplayPlayerOptions): ReplayPlayerState {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<OrangePlayer | null>(null);
  const draggingTimeline = useRef(false);
  const speedRef = useRef(1);
  const skipIdleRef = useRef(false);
  const [retryKey, requestRetry] = useReducer((key: number) => key + 1, 0);
  const [state, dispatch] = useReducer(
    playbackReducer,
    { durationMs: manifest.durationMs, mode },
    ({ durationMs, mode: initialMode }) => initialPlaybackState(durationMs, initialMode),
  );

  const timelineDurationMs = Math.max(state.durationMs, manifest.durationMs, state.currentMs);
  const isFollowing = mode === "live" || state.liveState.following;
  const playheadPercent = timelineProgressPercent(state.currentMs, timelineDurationMs);
  function seekTo(nextTimeMs: number, flash = false): void {
    const clampedTime = clampTime(nextTimeMs, timelineDurationMs);
    dispatch({ type: "seek", timeMs: clampedTime, flash });

    const player = playerRef.current;
    if (player === null) {
      return;
    }

    void player.seek(clampedTime).catch((caughtError: unknown) => {
      dispatch({
        type: "error",
        error: {
          message: readErrorMessage(caughtError),
          error: caughtError,
        },
      });
      dispatch({ type: "buffering", buffering: false });
    });
  }

  function togglePlayback(): void {
    const player = playerRef.current;
    if (player === null) {
      return;
    }

    dispatch({ type: "error", error: null });

    if (state.playing) {
      player.pause();
      dispatch({ type: "playing", playing: false });
      return;
    }

    void player
      .play()
      .then(() => dispatch({ type: "playing", playing: true }))
      .catch((caughtError: unknown) => {
        dispatch({
          type: "error",
          error: {
            message: readErrorMessage(caughtError),
            error: caughtError,
          },
        });
        dispatch({ type: "playing", playing: false });
        dispatch({ type: "buffering", buffering: false });
      });
  }

  function cycleSpeed(): void {
    dispatch({ type: "speed", speed: state.speed === 1 ? 2 : state.speed === 2 ? 4 : 1 });
  }

  function retryPlayer(): void {
    dispatch({ type: "error", error: null });
    requestRetry();
  }

  function seekFromPointer(event: ReactPointerEvent<HTMLDivElement>): void {
    const rect = event.currentTarget.getBoundingClientRect();
    seekTo(timelineXToTime(event.clientX - rect.left, timelineDurationMs, rect.width));
  }

  function startTimelineDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) {
      return;
    }

    draggingTimeline.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    seekFromPointer(event);
  }

  function moveTimelineDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!draggingTimeline.current) {
      return;
    }

    event.preventDefault();
    seekFromPointer(event);
  }

  function stopTimelineDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    draggingTimeline.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const action = getPlayerKeyAction(event);
    if (action === null) {
      return;
    }

    event.preventDefault();
    if (action.type === "toggle-play") {
      togglePlayback();
      return;
    }

    seekTo(state.currentMs + action.deltaMs);
  });

  useEffect(() => {
    speedRef.current = state.speed;
    playerRef.current?.setSpeed(state.speed);
  }, [state.speed]);

  useEffect(() => {
    skipIdleRef.current = state.skipIdle;
    playerRef.current?.setSkipInactivity(state.skipIdle);
  }, [state.skipIdle]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    const overlayColors = readReplayOverlayColors();
    const player = new OrangePlayer(container, {
      api: dashboardPlayerApi(manifest, isDemo),
      projectId,
      sessionId,
      token: isDemo ? demoPlayerAccessMarker : (getApiToken() ?? undefined),
      speed: speedRef.current,
      skipInactivity: skipIdleRef.current,
      overlay: overlayColors,
    });
    playerRef.current = player;

    const stopListening = [
      player.on("ready", (loadedManifest) => {
        dispatch({ type: "ready", durationMs: loadedManifest.durationMs });
      }),
      player.on("timeline", (timeline) => {
        dispatch({ type: "timeline", durationMs: timeline.durationMs });
      }),
      player.on("progress", (progress) => {
        dispatch({
          type: "progress",
          currentMs: progress.currentMs,
          durationMs: progress.durationMs,
        });
      }),
      player.on("segment", () => {
        dispatch({ type: "buffering", buffering: false });
      }),
      player.on("buffering", (event) => {
        dispatch({ type: "buffering", buffering: event.buffering });
      }),
      player.on("ended", () => {
        dispatch({ type: "playing", playing: false });
      }),
      player.on("live", (event) => {
        dispatch({ type: "live", liveState: event });
      }),
      player.on("waiting_keyframe", (event) => {
        dispatch({ type: "waitingKeyframe", waiting: event.waiting });
      }),
      player.on("error", (event) => {
        dispatch({ type: "error", error: event });
        dispatch({ type: "buffering", buffering: false });
      }),
    ];

    if (mode === "live") {
      player.follow();
    }

    return () => {
      for (const stop of stopListening) {
        stop();
      }
      player.destroy();
      if (playerRef.current === player) {
        playerRef.current = null;
      }
    };
  }, [isDemo, manifest, mode, projectId, retryKey, sessionId]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return {
    containerRef,
    state,
    values: {
      isFollowing,
      playheadPercent,
      timelineDurationMs,
    },
    actions: {
      cycleSpeed,
      retryPlayer,
      seekFromPointer,
      seekTo,
      stopTimelineDrag,
      startTimelineDrag,
      moveTimelineDrag,
      togglePlayback,
      toggleSkipIdle: () => dispatch({ type: "skipIdle" }),
    },
  };
}
