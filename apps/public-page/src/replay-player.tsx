import type { PublicPageRecording } from "@orange-replay/shared";
import { OrangePlayer } from "@orange-replay/player";
import { useEffect, useRef, useState } from "react";

interface ReplayPlayerProperties {
  publicId: string;
  recording: PublicPageRecording;
}

type ReplayState = "loading" | "paused" | "playing" | "buffering" | "ended" | "error";

export default function ReplayPlayer({ publicId, recording }: ReplayPlayerProperties) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<OrangePlayer | null>(null);
  const [replayState, setReplayState] = useState<ReplayState>("loading");
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(recording.durationMs);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const encodedPublicId = encodeURIComponent(publicId);
    const encodedReplayId = encodeURIComponent(recording.replayId);
    const player = new OrangePlayer(container, {
      projectId: publicId,
      sessionId: recording.replayId,
      api: {
        manifestUrl: () =>
          `/api/v1/public-pages/${encodedPublicId}/replays/${encodedReplayId}/manifest`,
        segmentUrl: ({ segmentName }) =>
          `/api/v1/public-pages/${encodedPublicId}/replays/${encodedReplayId}/segments/${encodeURIComponent(segmentName)}`,
      },
      skipInactivity: true,
      overlay: {
        cursorColor: "#f5a623",
        clickColor: "#f5a623",
        rageColor: "#ff5d5d",
      },
    });
    playerRef.current = player;

    const stopListening = [
      player.on("ready", (manifest) => {
        setDurationMs(manifest.durationMs);
        setReplayState("paused");
      }),
      player.on("progress", (progress) => {
        setCurrentMs(progress.currentMs);
        setDurationMs(progress.durationMs);
      }),
      player.on("buffering", ({ buffering }) => {
        setReplayState((current) =>
          buffering ? "buffering" : current === "buffering" ? "playing" : current,
        );
      }),
      player.on("ended", () => setReplayState("ended")),
      player.on("error", (error) => {
        if (error.severity === "warning" || error.severity === "recovering") return;
        setReplayState("error");
        setErrorMessage(error.message || "This recording could not be played.");
      }),
    ];

    return () => {
      for (const stop of stopListening) stop();
      player.destroy();
      playerRef.current = null;
    };
  }, [publicId, recording.replayId]);

  const togglePlayback = async () => {
    const player = playerRef.current;
    if (player === null || replayState === "loading" || replayState === "error") return;
    if (replayState === "playing" || replayState === "buffering") {
      player.pause();
      setReplayState("paused");
      return;
    }
    setReplayState("playing");
    try {
      await player.play();
    } catch (error) {
      setReplayState("error");
      setErrorMessage(
        error instanceof Error ? error.message : "This recording could not be played.",
      );
    }
  };

  const seek = async (nextMs: number) => {
    const player = playerRef.current;
    if (player === null) return;
    setCurrentMs(nextMs);
    try {
      await player.seek(nextMs);
    } catch (error) {
      setReplayState("error");
      setErrorMessage(
        error instanceof Error ? error.message : "This recording could not be played.",
      );
    }
  };

  return (
    <div className="public-player">
      <div className="public-player-stage" ref={containerRef} />
      <div className="public-player-controls">
        <button className="watch-button" type="button" onClick={() => void togglePlayback()}>
          {replayState === "playing" || replayState === "buffering" ? "Pause" : "Play"}
        </button>
        <label className="player-timeline">
          <span className="sr-only">Replay position</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, durationMs)}
            step={100}
            value={Math.min(currentMs, Math.max(1, durationMs))}
            disabled={replayState === "loading" || replayState === "error"}
            onChange={(event) => void seek(Number(event.currentTarget.value))}
          />
        </label>
        <output>
          {formatTime(currentMs)} / {formatTime(durationMs)}
        </output>
        <span className="player-status" role="status">
          {replayState === "buffering" ? "Buffering" : replayState}
        </span>
      </div>
      {errorMessage !== null ? <p className="player-error">{errorMessage}</p> : null}
    </div>
  );
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
