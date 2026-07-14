import {
  useEffect,
  useEffectEvent,
  useReducer,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { OrangePlayer } from "@orange-replay/player";
import type { BatchIndex, LiveSessionSnapshot, SessionManifest } from "@orange-replay/shared/types";
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
  liveReviewManifest?: SessionManifest;
  mode: ReplayMode;
  projectId: string;
  sessionId: string;
  onLiveIndex?: (index: BatchIndex) => void;
  onLiveSnapshot?: (snapshot: LiveSessionSnapshot) => void;
  onLiveFinalized?: (manifest: SessionManifest) => void;
  onLiveEnded?: () => void;
  reviewLiveHistory?: boolean;
}

export interface ReplayPlayerState {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the timeline slider; the hook drives its `--playhead` CSS var
      per frame so the needle stays smooth without React renders. */
  timelineRef: React.RefObject<HTMLDivElement | null>;
  state: PlaybackState;
  values: {
    isFollowing: boolean;
    playheadPercent: number;
    timelineDurationMs: number;
  };
  actions: {
    cycleSpeed: () => void;
    seekAndPlay: (timeMs: number, flash?: boolean) => void;
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

export function useReplayPlayer({
  manifest,
  isDemo,
  liveReviewManifest,
  mode,
  onLiveIndex,
  onLiveEnded,
  onLiveFinalized,
  onLiveSnapshot,
  projectId,
  reviewLiveHistory = false,
  sessionId,
}: ReplayPlayerOptions): ReplayPlayerState {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<OrangePlayer | null>(null);
  const latestManifestRef = useRef(manifest);
  const latestModeRef = useRef(mode);
  const playerManifestRef = useRef<SessionManifest | null>(null);
  latestManifestRef.current = manifest;
  latestModeRef.current = mode;
  const draggingTimeline = useRef(false);
  const progressFrameRef = useRef<number | null>(null);
  const pendingProgressRef = useRef<{ currentMs: number; durationMs: number } | null>(null);
  // Playback commits to React only when the displayed second changes; the
  // smooth per-frame needle runs through the --playhead CSS var instead.
  const lastCommittedSecondRef = useRef(-1);
  const lastCommittedDurationRef = useRef(-1);
  const dragSeekTimeoutRef = useRef<number | null>(null);
  const lastDragSeekAtRef = useRef(0);
  const pendingDragMsRef = useRef<number | null>(null);
  const speedRef = useRef(1);
  const skipIdleRef = useRef(false);
  const [retryKey, requestRetry] = useReducer((key: number) => key + 1, 0);
  const [state, dispatch] = useReducer(
    playbackReducer,
    { durationMs: manifest.durationMs, mode },
    ({ durationMs, mode: initialMode }) => initialPlaybackState(durationMs, initialMode),
  );

  const timelineDurationMs = Math.max(state.durationMs, manifest.durationMs, state.currentMs);
  const isFollowing = state.liveState.following;
  const playheadPercent = timelineProgressPercent(state.currentMs, timelineDurationMs);

  function writePlayheadVar(timeMs: number, durationMs: number): void {
    timelineRef.current?.style.setProperty(
      "--playhead",
      `${timelineProgressPercent(timeMs, durationMs)}%`,
    );
  }

  function issuePlayerSeek(timeMs: number): void {
    const player = playerRef.current;
    if (player === null) {
      return;
    }

    void player.seek(timeMs).catch((caughtError: unknown) => {
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

  function seekTo(nextTimeMs: number, flash = false): void {
    const clampedTime = clampTime(nextTimeMs, timelineDurationMs);
    dispatch({ type: "seek", timeMs: clampedTime, flash });
    lastCommittedSecondRef.current = Math.floor(clampedTime / 1000);
    writePlayheadVar(clampedTime, timelineDurationMs);
    issuePlayerSeek(clampedTime);
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

  function seekAndPlay(nextTimeMs: number, flash = false): void {
    const clampedTime = clampTime(nextTimeMs, timelineDurationMs);
    dispatch({ type: "seek", timeMs: clampedTime, flash });
    dispatch({ type: "error", error: null });
    lastCommittedSecondRef.current = Math.floor(clampedTime / 1000);
    writePlayheadVar(clampedTime, timelineDurationMs);

    const player = playerRef.current;
    if (player === null) {
      return;
    }

    player.pause();
    dispatch({ type: "playing", playing: false });
    void player
      .seek(clampedTime)
      .then(() => player.play())
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
    dispatch({ type: "retry" });
    requestRetry();
  }

  function pointerTime(event: ReactPointerEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    return clampTime(
      timelineXToTime(event.clientX - rect.left, timelineDurationMs, rect.width),
      timelineDurationMs,
    );
  }

  function seekFromPointer(event: ReactPointerEvent<HTMLDivElement>): void {
    seekTo(pointerTime(event));
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

  // rrweb seeks rebuild from the nearest snapshot, so a drag must not issue
  // one per pointermove. The needle and time label follow the pointer
  // immediately; the actual player seek is throttled and flushed on release.
  function moveTimelineDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!draggingTimeline.current) {
      return;
    }

    event.preventDefault();
    const timeMs = pointerTime(event);
    writePlayheadVar(timeMs, timelineDurationMs);
    const second = Math.floor(timeMs / 1000);
    if (second !== lastCommittedSecondRef.current) {
      lastCommittedSecondRef.current = second;
      dispatch({ type: "seek", timeMs, flash: false });
    }

    pendingDragMsRef.current = timeMs;
    const now = performance.now();
    if (now - lastDragSeekAtRef.current >= 110) {
      lastDragSeekAtRef.current = now;
      pendingDragMsRef.current = null;
      issuePlayerSeek(timeMs);
      return;
    }

    if (dragSeekTimeoutRef.current === null) {
      dragSeekTimeoutRef.current = window.setTimeout(() => {
        dragSeekTimeoutRef.current = null;
        const pending = pendingDragMsRef.current;
        if (pending === null || !draggingTimeline.current) return;
        pendingDragMsRef.current = null;
        lastDragSeekAtRef.current = performance.now();
        issuePlayerSeek(pending);
      }, 110);
    }
  }

  function stopTimelineDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const wasDragging = draggingTimeline.current;
    draggingTimeline.current = false;
    if (dragSeekTimeoutRef.current !== null) {
      window.clearTimeout(dragSeekTimeoutRef.current);
      dragSeekTimeoutRef.current = null;
    }
    if (wasDragging && pendingDragMsRef.current !== null) {
      seekTo(pendingDragMsRef.current);
      pendingDragMsRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (state.liveState.following) {
      return;
    }

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
  const handleLiveIndex = useEffectEvent((index: BatchIndex) => onLiveIndex?.(index));
  const handleLiveEnded = useEffectEvent(() => onLiveEnded?.());
  const handleLiveFinalized = useEffectEvent((nextManifest: SessionManifest) =>
    onLiveFinalized?.(nextManifest),
  );
  const handleLiveSnapshot = useEffectEvent((snapshot: LiveSessionSnapshot) =>
    onLiveSnapshot?.(snapshot),
  );

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

    const initialManifest = latestManifestRef.current;
    const initialMode = latestModeRef.current;
    const overlayColors = readReplayOverlayColors();
    const player = new OrangePlayer(container, {
      api: dashboardPlayerApi(initialManifest, isDemo),
      projectId,
      sessionId,
      token: isDemo ? undefined : (getApiToken() ?? undefined),
      speed: speedRef.current,
      skipInactivity: skipIdleRef.current,
      overlay: overlayColors,
    });
    playerRef.current = player;
    playerManifestRef.current = initialManifest;

    // Per frame: only the cheap CSS-var write for the needle. React commits
    // happen when the displayed second (or duration) changes, so steady
    // playback renders ~1x/s instead of 60x/s.
    const flushProgress = (): void => {
      progressFrameRef.current = null;
      const pendingProgress = pendingProgressRef.current;
      pendingProgressRef.current = null;
      if (pendingProgress === null) return;
      if (draggingTimeline.current) return;

      const effectiveDurationMs = Math.max(
        pendingProgress.durationMs,
        latestManifestRef.current.durationMs,
        pendingProgress.currentMs,
      );
      timelineRef.current?.style.setProperty(
        "--playhead",
        `${timelineProgressPercent(pendingProgress.currentMs, effectiveDurationMs)}%`,
      );

      const second = Math.floor(pendingProgress.currentMs / 1000);
      if (
        second === lastCommittedSecondRef.current &&
        pendingProgress.durationMs === lastCommittedDurationRef.current
      ) {
        return;
      }
      lastCommittedSecondRef.current = second;
      lastCommittedDurationRef.current = pendingProgress.durationMs;
      dispatch({ type: "progress", ...pendingProgress });
    };

    const stopListening = [
      player.on("ready", (loadedManifest) => {
        dispatch({ type: "ready", durationMs: loadedManifest.durationMs });
      }),
      player.on("timeline", (timeline) => {
        dispatch({
          type: "timeline",
          durationMs: timeline.durationMs,
          deadClicks: timeline.deadClicks,
        });
      }),
      player.on("progress", (progress) => {
        pendingProgressRef.current = {
          currentMs: progress.currentMs,
          durationMs: progress.durationMs,
        };
        if (progressFrameRef.current !== null) return;
        progressFrameRef.current = window.requestAnimationFrame(flushProgress);
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
      player.on("live_index", handleLiveIndex),
      player.on("live_finalized", handleLiveFinalized),
      player.on("live_ended", handleLiveEnded),
      player.on("live_snapshot", handleLiveSnapshot),
      player.on("waiting_keyframe", (event) => {
        dispatch({ type: "waitingKeyframe", waiting: event.waiting });
      }),
      player.on("error", (event) => {
        if (event.severity === "warning" || event.severity === "recovering") {
          return;
        }
        dispatch({ type: "error", error: event });
        dispatch({ type: "playing", playing: false });
        dispatch({ type: "buffering", buffering: false });
      }),
    ];

    if (initialMode === "live") {
      player.follow();
    }

    return () => {
      if (progressFrameRef.current !== null) {
        window.cancelAnimationFrame(progressFrameRef.current);
        progressFrameRef.current = null;
      }
      if (dragSeekTimeoutRef.current !== null) {
        window.clearTimeout(dragSeekTimeoutRef.current);
        dragSeekTimeoutRef.current = null;
      }
      pendingProgressRef.current = null;
      pendingDragMsRef.current = null;
      lastCommittedSecondRef.current = -1;
      lastCommittedDurationRef.current = -1;
      for (const stop of stopListening) {
        stop();
      }
      player.destroy();
      playerManifestRef.current = null;
      if (playerRef.current === player) {
        playerRef.current = null;
      }
    };
  }, [isDemo, projectId, retryKey, sessionId]);

  // The player owns the visible replay surface. Adopt the final manifest in
  // place so the live frame and current time survive the source handoff.
  useEffect(() => {
    const player = playerRef.current;
    if (player === null || mode !== "recorded" || playerManifestRef.current === manifest) {
      return;
    }
    playerManifestRef.current = manifest;
    player.finishLive(manifest);
  }, [manifest, mode]);

  useEffect(() => {
    const player = playerRef.current;
    if (player === null || mode !== "live") return;
    if (reviewLiveHistory) {
      player.reviewLiveHistory(liveReviewManifest ?? manifest);
      return;
    }
    player.follow();
  }, [liveReviewManifest, manifest, mode, reviewLiveHistory]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return {
    containerRef,
    timelineRef,
    state,
    values: {
      isFollowing,
      playheadPercent,
      timelineDurationMs,
    },
    actions: {
      cycleSpeed,
      seekAndPlay,
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
