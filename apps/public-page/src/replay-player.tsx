import type { PublicPageRecording } from "@orange-replay/shared";
import { OrangePlayer, type ReplayTab } from "@orange-replay/player";
import { domMaskingDescription, summarizeDomMasking } from "@orange-replay/shared/dom-masking";
import { useEffect, useRef, useState } from "react";

interface ReplayPlayerProperties {
  publicId: string;
  recording: PublicPageRecording;
}

type ReplayState = "loading" | "paused" | "playing" | "buffering" | "ended" | "error";
const replayErrorMessage = "Unable to play this session. Refresh the page and try again.";

export default function ReplayPlayer({ publicId, recording }: ReplayPlayerProperties) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<OrangePlayer | null>(null);
  const [replayState, setReplayState] = useState<ReplayState>("loading");
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(recording.durationMs);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tabs, setTabs] = useState<ReplayTab[]>([]);
  const [selectedTab, setSelectedTab] = useState<string | undefined>();
  const [masking, setMasking] = useState(() =>
    domMaskingDescription(summarizeDomMasking(undefined)),
  );
  const playingRef = useRef(false);

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
        setMasking(
          domMaskingDescription(
            manifest.domMaskingSummary ?? summarizeDomMasking(manifest.domMasking),
          ),
        );
      }),
      player.on("tabs", (state) => {
        setTabs(state.tabs);
        setSelectedTab(state.selectedTab);
      }),
      player.on("progress", (progress) => {
        setCurrentMs(progress.currentMs);
        setDurationMs(progress.durationMs);
      }),
      player.on("buffering", ({ buffering }) => {
        setReplayState((current) =>
          buffering
            ? "buffering"
            : current === "buffering"
              ? playingRef.current
                ? "playing"
                : "paused"
              : current,
        );
      }),
      player.on("ended", () => {
        playingRef.current = false;
        setReplayState("ended");
      }),
      player.on("error", (error) => {
        if (error.severity === "warning" || error.severity === "recovering") return;
        setReplayState("error");
        setErrorMessage(replayErrorMessage);
      }),
    ];

    return () => {
      for (const stop of stopListening) stop();
      player.destroy();
      playingRef.current = false;
      playerRef.current = null;
    };
  }, [publicId, recording.replayId]);

  const togglePlayback = async () => {
    const player = playerRef.current;
    if (player === null || replayState === "loading" || replayState === "error") return;
    if (replayState === "playing" || replayState === "buffering") {
      player.pause();
      playingRef.current = false;
      setReplayState("paused");
      return;
    }
    setReplayState("playing");
    playingRef.current = true;
    try {
      await player.play();
    } catch {
      playingRef.current = false;
      setReplayState("error");
      setErrorMessage(replayErrorMessage);
    }
  };

  const selectTab = async (tab: string) => {
    try {
      await playerRef.current?.selectTab(tab);
    } catch {
      setErrorMessage(replayErrorMessage);
    }
  };

  const seek = async (nextMs: number) => {
    const player = playerRef.current;
    if (player === null) return;
    setCurrentMs(nextMs);
    try {
      await player.seek(nextMs);
    } catch {
      setReplayState("error");
      setErrorMessage(replayErrorMessage);
    }
  };

  return (
    <div className="public-player">
      {tabs.length > 1 && (
        <label className="public-player-tabs">
          Replay tab
          <select
            aria-label="Replay tab"
            value={selectedTab ?? tabs[0]!.id}
            onChange={(event) => void selectTab(event.currentTarget.value)}
          >
            {tabs.map((tab) => (
              <option key={tab.id} value={tab.id} disabled={tab.firstSnapshotAt === undefined}>
                {tab.label}
                {tab.firstSnapshotAt === undefined ? " · Replay unavailable" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
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
      <p className="public-player-masking">{masking}</p>
    </div>
  );
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
