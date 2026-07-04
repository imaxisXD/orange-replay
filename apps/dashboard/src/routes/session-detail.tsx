import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link, useParams } from "react-router";
import { AlertCircle, ArrowLeft, Check, Copy, RotateCcw } from "lucide-react";
import { OrangePlayer, type PlayerApi, type PlayerErrorEvent } from "@orange-replay/player";
import type { SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import { StatusPill } from "@/components/status-pill";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ApiError,
  fetchLiveSessions,
  getApiToken,
  getManifest,
  type LiveSessionItem,
} from "@/lib/api";
import { formatBytes, formatDuration, formatErrorCount } from "@/lib/format";
import {
  buildTimelineTickBuckets,
  getPlayerKeyAction,
  mapTimelineSidebarRows,
  timelineProgressPercent,
  timelineXToTime,
  type TimelineDot,
  type TimelineSidebarRow,
} from "@/lib/replay-timeline";
import { defaultProjectId } from "@/router";

type ReplayMode = "recorded" | "live";

interface SeekRequest {
  id: number;
  timeMs: number;
}

export function SessionDetailPage() {
  const params = useParams();
  const projectId = params.projectId ?? defaultProjectId;
  const sessionId = params.sessionId;
  const [manifest, setManifest] = useState<SessionManifest | null>(null);
  const [mode, setMode] = useState<ReplayMode>("recorded");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const loadSerial = useRef(0);

  const loadManifest = useCallback(
    async (signal?: AbortSignal) => {
      if (sessionId === undefined) return;

      loadSerial.current += 1;
      const loadId = loadSerial.current;
      const isStale = () => signal?.aborted === true || loadSerial.current !== loadId;

      setLoading(true);
      setError("");
      setNotFound(false);

      try {
        const nextManifest = await getManifest(projectId, sessionId, { signal });
        if (isStale()) return;
        setManifest(nextManifest);
        setMode("recorded");
      } catch (caughtError) {
        if (isStale()) return;
        setManifest(null);

        if (isNotFound(caughtError)) {
          try {
            const liveSessions = await fetchLiveSessions(projectId, { signal });
            if (isStale()) return;
            const liveSession = liveSessions.sessions.find(
              (session) => session.session_id === sessionId,
            );

            if (liveSession !== undefined) {
              setManifest(liveSessionManifest(projectId, sessionId, liveSession));
              setMode("live");
              return;
            }

            setNotFound(true);
          } catch (liveError) {
            if (isStale()) return;
            setError(readErrorMessage(liveError));
          }
          return;
        }

        setError(readErrorMessage(caughtError));
      } finally {
        if (!isStale()) {
          setLoading(false);
        }
      }
    },
    [projectId, sessionId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadManifest(controller.signal);
    return () => {
      controller.abort();
      loadSerial.current += 1;
    };
  }, [loadManifest]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copySessionId(): Promise<void> {
    if (sessionId === undefined) return;
    await navigator.clipboard.writeText(sessionId);
    setCopied(true);
  }

  if (sessionId === undefined) {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden />
        <AlertTitle>Missing session id</AlertTitle>
        <AlertDescription>The route does not include a session id.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <Button asChild leadingIcon={ArrowLeft} size="sm" variant="ghost">
          <Link to={`/projects/${projectId}/sessions`}>Sessions</Link>
        </Button>
        <Button
          leadingIcon={RotateCcw}
          onClick={() => void loadManifest()}
          size="sm"
          variant="ghost"
        >
          Refresh manifest
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">Session</h1>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] text-muted-foreground">{sessionId}</span>
          <Tooltip content="Copy session id">
            <Button
              aria-label="Copy session id"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void copySessionId()}
              size="icon-sm"
              variant="ghost"
            >
              {copied ? (
                <Check aria-hidden className="size-4 text-success" />
              ) : (
                <Copy aria-hidden className="size-4" />
              )}
            </Button>
          </Tooltip>
        </div>
      </div>

      {error.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load manifest</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {notFound && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Session not found</AlertTitle>
          <AlertDescription>This session is not available.</AlertDescription>
        </Alert>
      )}

      {loading ? <DetailLoading /> : manifest !== null && <ManifestHeader manifest={manifest} />}

      {!loading && manifest !== null && (
        <ReplayWorkspace
          manifest={manifest}
          mode={mode}
          projectId={projectId}
          sessionId={sessionId}
        />
      )}

      {manifest !== null && manifest.segments.length > 0 && (
        <SegmentTable segments={manifest.segments} />
      )}
    </div>
  );
}

function ReplayWorkspace({
  manifest,
  mode,
  projectId,
  sessionId,
}: {
  manifest: SessionManifest;
  mode: ReplayMode;
  projectId: string;
  sessionId: string;
}) {
  const seekSerial = useRef(0);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  const rows = useMemo(
    () =>
      mapTimelineSidebarRows(manifest.timeline, {
        startedAt: manifest.startedAt,
        durationMs: manifest.durationMs,
      }),
    [manifest],
  );

  const requestSeek = useCallback((timeMs: number) => {
    seekSerial.current += 1;
    setSeekRequest({ id: seekSerial.current, timeMs });
  }, []);

  return (
    <section className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1fr_320px]">
      <ReplayPlayerCard
        manifest={manifest}
        mode={mode}
        projectId={projectId}
        seekRequest={seekRequest}
        sessionId={sessionId}
      />
      <TimelineSidebar onSeek={requestSeek} rows={rows} />
    </section>
  );
}

function ReplayPlayerCard({
  manifest,
  mode,
  projectId,
  seekRequest,
  sessionId,
}: {
  manifest: SessionManifest;
  mode: ReplayMode;
  projectId: string;
  seekRequest: SeekRequest | null;
  sessionId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<OrangePlayer | null>(null);
  const draggingTimeline = useRef(false);
  const [ready, setReady] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(manifest.durationMs);
  const [speed, setSpeed] = useState(1);
  const [skipIdle, setSkipIdle] = useState(false);
  const [playerError, setPlayerError] = useState<PlayerErrorEvent | null>(null);
  const [liveState, setLiveState] = useState({ following: mode === "live", connected: false });
  const [waitingForKeyframe, setWaitingForKeyframe] = useState(mode === "live");
  const [retryKey, setRetryKey] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const speedRef = useRef(speed);
  const skipIdleRef = useRef(skipIdle);
  const timelineDurationMs = Math.max(durationMs, manifest.durationMs, currentMs);
  const isFollowing = mode === "live" || liveState.following;
  const playheadPercent = timelineProgressPercent(currentMs, timelineDurationMs);
  const timelineBuckets = useMemo(
    () =>
      buildTimelineTickBuckets(manifest.timeline, {
        startedAt: manifest.startedAt,
        durationMs: manifest.durationMs,
        bucketCount: 36,
      }),
    [manifest],
  );
  const errorMarkers = useMemo(
    () =>
      manifest.timeline
        .filter((event) => event.k === "error")
        .map((event) => ({
          id: `${event.t}-${event.d ?? "error"}`,
          leftPercent: timelineProgressPercent(event.t - manifest.startedAt, manifest.durationMs),
        })),
    [manifest],
  );

  const seekTo = useCallback(
    (nextTimeMs: number, flash = false) => {
      const clampedTime = clampTime(nextTimeMs, timelineDurationMs);
      setCurrentMs(clampedTime);
      if (flash) {
        setFlashKey((value) => value + 1);
      }

      const player = playerRef.current;
      if (player === null) {
        return;
      }

      void player.seek(clampedTime).catch((caughtError: unknown) => {
        setPlayerError({
          message: readErrorMessage(caughtError),
          error: caughtError,
        });
        setBuffering(false);
      });
    },
    [timelineDurationMs],
  );

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    if (player === null) {
      return;
    }

    setPlayerError(null);

    if (playing) {
      player.pause();
      setPlaying(false);
      return;
    }

    void player
      .play()
      .then(() => setPlaying(true))
      .catch((caughtError: unknown) => {
        setPlayerError({
          message: readErrorMessage(caughtError),
          error: caughtError,
        });
        setPlaying(false);
        setBuffering(false);
      });
  }, [playing]);

  useEffect(() => {
    speedRef.current = speed;
    playerRef.current?.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    skipIdleRef.current = skipIdle;
    playerRef.current?.setSkipInactivity(skipIdle);
  }, [skipIdle]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    setReady(false);
    setBuffering(false);
    setPlaying(false);
    setCurrentMs(0);
    setDurationMs(manifest.durationMs);
    setPlayerError(null);
    setLiveState({ following: mode === "live", connected: false });
    setWaitingForKeyframe(mode === "live");

    const player = new OrangePlayer(container, {
      api: dashboardPlayerApi(manifest),
      projectId,
      sessionId,
      token: getApiToken() ?? undefined,
      speed: speedRef.current,
      skipInactivity: skipIdleRef.current,
      overlay: {
        cursorColor: "#f5a623",
        clickColor: "#f5a623",
        rageColor: "#f4534e",
      },
    });
    playerRef.current = player;

    const stopListening = [
      player.on("ready", (loadedManifest) => {
        setReady(true);
        setDurationMs(loadedManifest.durationMs);
        setBuffering(false);
      }),
      player.on("timeline", (timeline) => {
        setDurationMs(timeline.durationMs);
      }),
      player.on("progress", (progress) => {
        setCurrentMs(progress.currentMs);
        setDurationMs(progress.durationMs);
      }),
      player.on("segment", () => {
        setBuffering(false);
      }),
      player.on("buffering", (event) => {
        setBuffering(event.buffering);
      }),
      player.on("ended", () => {
        setPlaying(false);
      }),
      player.on("live", (event) => {
        setLiveState(event);
      }),
      player.on("waiting_keyframe", (event) => {
        setWaitingForKeyframe(event.waiting);
      }),
      player.on("error", (event) => {
        setPlayerError(event);
        setBuffering(false);
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
  }, [manifest, mode, projectId, retryKey, sessionId]);

  useEffect(() => {
    if (seekRequest === null) {
      return;
    }

    seekTo(seekRequest.timeMs, true);
  }, [seekRequest, seekTo]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = getPlayerKeyAction(event);
      if (action === null) {
        return;
      }

      event.preventDefault();
      if (action.type === "toggle-play") {
        togglePlayback();
        return;
      }

      seekTo(currentMs + action.deltaMs);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentMs, seekTo, togglePlayback]);

  const cycleSpeed = useCallback(() => {
    setSpeed((value) => (value === 1 ? 2 : value === 2 ? 4 : 1));
  }, []);

  const retryPlayer = useCallback(() => {
    setPlayerError(null);
    setRetryKey((value) => value + 1);
  }, []);

  const seekFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      seekTo(timelineXToTime(event.clientX - rect.left, timelineDurationMs, rect.width));
    },
    [seekTo, timelineDurationMs],
  );

  const handleTimelinePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      draggingTimeline.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      seekFromPointer(event);
    },
    [seekFromPointer],
  );

  const handleTimelinePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingTimeline.current) {
        return;
      }

      event.preventDefault();
      seekFromPointer(event);
    },
    [seekFromPointer],
  );

  const stopTimelineDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    draggingTimeline.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <section className="lit overflow-hidden rounded-lg">
      <div className="relative aspect-video min-h-[360px] overflow-hidden bg-background">
        <div
          ref={containerRef}
          className="absolute inset-0 [&_.replayer-wrapper]:!h-full [&_.replayer-wrapper]:!w-full [&_iframe]:!h-full [&_iframe]:!w-full"
        />

        {!ready && playerError === null && (
          <div className="absolute inset-0 z-20 p-4">
            <Skeleton className="h-full w-full rounded-md" />
          </div>
        )}

        {ready && isFollowing && waitingForKeyframe && playerError === null && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background/72">
            <span className="live-pulse size-[9px] rounded-full bg-success" />
            <span className="text-[13px] text-muted-foreground">
              Connected live — waiting for the next keyframe…
            </span>
          </div>
        )}

        {ready && buffering && !waitingForKeyframe && playerError === null && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background/72">
            <span className="size-8 animate-spin rounded-full border border-dash border-t-amber" />
            <span className="text-[13px] text-muted-foreground">Buffering…</span>
          </div>
        )}

        {playerError !== null && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/82 p-4">
            <Alert className="max-w-md" variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>Could not play replay</AlertTitle>
              <AlertDescription>
                <p>{playerError.message}</p>
                <Button onClick={retryPlayer} size="sm" variant="secondary">
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
      </div>

      <div className="flex items-center gap-[14px] overflow-x-auto border-t border-dashed border-dash px-4 py-[13px]">
        <button
          aria-label={playing ? "Pause replay" : "Play replay"}
          className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-foreground text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-amber"
          onClick={togglePlayback}
          type="button"
        >
          <PlayPauseShape playing={playing} />
        </button>

        <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
          {formatDuration(currentMs)}
        </span>

        <div
          aria-label="Replay timeline"
          aria-valuemax={Math.round(timelineDurationMs)}
          aria-valuemin={0}
          aria-valuenow={Math.round(currentMs)}
          className="relative h-[26px] min-w-[160px] flex-1 cursor-pointer touch-none"
          onPointerCancel={stopTimelineDrag}
          onPointerDown={handleTimelinePointerDown}
          onPointerMove={handleTimelinePointerMove}
          onPointerUp={stopTimelineDrag}
          role="slider"
          tabIndex={0}
        >
          <div className="absolute right-0 left-0 top-[12px] border-t border-dashed border-dash" />

          {timelineBuckets
            .filter((bucket) => bucket.count > 0)
            .map((bucket) => (
              <span
                aria-hidden
                className="absolute bottom-1 w-[4px] rounded-[1.5px] bg-[#2e2e38]"
                key={bucket.index}
                style={{
                  height: `${bucket.heightPx}px`,
                  left: `${bucket.leftPercent}%`,
                }}
              />
            ))}

          {errorMarkers.map((marker) => (
            <span
              aria-hidden
              className="absolute top-0 h-full w-[2px] bg-danger shadow-[0_0_8px_rgba(244,83,78,0.7)]"
              key={marker.id}
              style={{ left: `${marker.leftPercent}%` }}
            />
          ))}

          <span
            aria-hidden
            className={
              flashKey > 0
                ? "timeline-playhead-flash absolute top-0 bottom-0 w-[2px] bg-amber shadow-[0_0_9px_rgba(245,166,35,0.7)] after:absolute after:-top-[3px] after:-left-[3px] after:size-2 after:rounded-full after:bg-amber"
                : "absolute top-0 bottom-0 w-[2px] bg-amber shadow-[0_0_9px_rgba(245,166,35,0.7)] after:absolute after:-top-[3px] after:-left-[3px] after:size-2 after:rounded-full after:bg-amber"
            }
            key={flashKey}
            style={{ left: `${playheadPercent}%` }}
          />
        </div>

        {isFollowing ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] font-medium text-success">
            <span className="live-pulse size-[7px] rounded-full bg-success" />
            LIVE
          </span>
        ) : (
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {formatDuration(timelineDurationMs)}
          </span>
        )}

        {!isFollowing && (
          <Button
            className="font-mono text-[12.5px] text-muted-foreground hover:text-foreground"
            onClick={cycleSpeed}
            size="sm"
            variant="secondary"
          >
            {speed}×
          </Button>
        )}

        <Switch
          checked={skipIdle}
          className="px-0 py-0 [&>span:last-child]:text-[11.5px]"
          label="Skip idle"
          onToggle={() => setSkipIdle((value) => !value)}
        />

        <div className="flex gap-[5px]">
          <kbd className="rounded-[5px] border border-border bg-secondary px-[6px] py-[2px] font-mono text-[10.5px] text-muted-foreground">
            ←
          </kbd>
          <kbd className="rounded-[5px] border border-border bg-secondary px-[6px] py-[2px] font-mono text-[10.5px] text-muted-foreground">
            →
          </kbd>
          <kbd className="rounded-[5px] border border-border bg-secondary px-[6px] py-[2px] font-mono text-[10.5px] text-muted-foreground">
            space
          </kbd>
        </div>
      </div>
    </section>
  );
}

function TimelineSidebar({
  onSeek,
  rows,
}: {
  onSeek: (timeMs: number) => void;
  rows: TimelineSidebarRow[];
}) {
  return (
    <aside className="lit flex h-full min-h-0 flex-col rounded-lg px-[18px] py-4 max-lg:max-h-[360px]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold">Timeline</h2>
        <span className="text-[11.5px] text-dim">{rows.length} events</span>
      </div>

      {rows.length === 0 ? (
        <div className="mt-4 flex min-h-[140px] items-center justify-center rounded-lg border border-dashed border-dash text-[12.5px] text-muted-foreground">
          No indexed events.
        </div>
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          {rows.map((row) => (
            <button
              className="flex w-full items-center gap-[10px] border-b border-dashed border-dash py-[8px] text-left outline-none transition-colors last:border-b-0 hover:bg-hover focus-visible:ring-1 focus-visible:ring-amber"
              key={row.id}
              onClick={() => onSeek(row.offsetMs)}
              type="button"
            >
              <span className={`size-[6px] shrink-0 rounded-full ${dotClass(row.dot)}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-foreground">{row.label}</span>
                {row.detail !== undefined && (
                  <span className="block truncate text-[11.5px] text-dim">{row.detail}</span>
                )}
              </span>
              <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                {row.offsetLabel}
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

function PlayPauseShape({ playing }: { playing: boolean }) {
  if (playing) {
    return (
      <span className="flex items-center gap-[4px]" aria-hidden>
        <span className="h-[14px] w-[4px] rounded-[1px] bg-background" />
        <span className="h-[14px] w-[4px] rounded-[1px] bg-background" />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className="ml-[2px] h-0 w-0 border-y-[7px] border-l-[10px] border-y-transparent border-l-background"
    />
  );
}

function dotClass(dot: TimelineDot): string {
  if (dot === "blue") return "bg-[#4a9eff]";
  if (dot === "danger") return "bg-danger";
  if (dot === "amber") return "bg-amber";
  return "bg-teal";
}

function ManifestHeader({ manifest }: { manifest: SessionManifest }) {
  const attrs = manifest.attrs;
  const errors = manifest.counts.errors;
  const rageClicks = manifest.counts.rages;

  return (
    <section className="lit overflow-hidden rounded-lg">
      <div className="flex overflow-x-auto">
        <Metric label="Duration" value={formatDuration(manifest.durationMs)} />
        <Metric label="Events" value={String(manifest.counts.events)} />
        <Metric label="Errors" value={String(errors)} warm={errors > 0} />
        <Metric label="Rage clicks" value={String(rageClicks)} warm={rageClicks > 0} />
      </div>

      <div className="flex flex-wrap gap-2 px-[18px] pb-[15px]">
        {errors > 0 && <StatusPill kind="err">{formatErrorCount(errors)}</StatusPill>}
        {rageClicks > 0 && <StatusPill kind="rage">{rageClicks} rage</StatusPill>}
        <StatusPill kind="neutral">{formatCountry(attrs.country)}</StatusPill>
        <StatusPill kind="neutral">
          {attrs.browser ?? "Unknown"}
          <span className="px-1 text-dim">·</span>
          {attrs.os ?? "Unknown"}
        </StatusPill>
      </div>
    </section>
  );
}

function Metric({ label, value, warm = false }: { label: string; value: string; warm?: boolean }) {
  return (
    <div className="min-w-[180px] flex-1 border-r border-dashed border-dash px-[18px] py-[15px] last:border-r-0">
      <div className="mb-[6px] text-[11.5px] text-muted-foreground">{label}</div>
      <div
        className={
          warm
            ? "font-mono text-[21px] font-semibold tracking-[-0.02em] text-amber"
            : "font-mono text-[21px] font-semibold tracking-[-0.02em] text-foreground"
        }
      >
        {value}
      </div>
    </div>
  );
}

function DetailLoading() {
  return (
    <section className="lit overflow-hidden rounded-lg">
      <div className="flex overflow-x-auto">
        {Array.from({ length: 4 }, (_unused, index) => (
          <div
            className="min-w-[180px] flex-1 border-r border-dashed border-dash px-[18px] py-[15px] last:border-r-0"
            key={index}
          >
            <Skeleton className="mb-[6px] h-3 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>
      <div className="flex gap-2 px-[18px] pb-[15px]">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-6 w-28 rounded-full" />
      </div>
    </section>
  );
}

function SegmentTable({ segments }: { segments: SegmentRef[] }) {
  return (
    <section className="lit overflow-hidden rounded-lg">
      <div className="border-b border-dashed border-dash px-4 py-3">
        <h2 className="text-[15px] font-medium">Segments</h2>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Segment</TableHead>
              <TableHead className="text-right">Time</TableHead>
              <TableHead className="text-right">Batches</TableHead>
              <TableHead className="text-right">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {segments.map((segment, index) => (
              <TableRow index={index} key={segment.key}>
                <TableCell className="font-mono text-[12px] text-muted-foreground">
                  {firstSegmentName(segment.key)}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] text-foreground">
                  {formatDuration(segment.t1 - segment.t0)}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
                  {segment.batches}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
                  {formatBytes(segment.bytes)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function firstSegmentName(key: string): string {
  return key.split("/").at(-1) ?? key;
}

function dashboardPlayerApi(manifest: SessionManifest): PlayerApi {
  const manifestRequestPath = manifestPath(manifest.projectId, manifest.sessionId);

  return {
    fetch(input, init) {
      if (matchesPath(input, manifestRequestPath)) {
        return Promise.resolve(
          new Response(JSON.stringify(manifest), {
            headers: { "content-type": "application/json" },
          }),
        );
      }

      return fetch(input, init);
    },
  };
}

function liveSessionManifest(
  projectId: string,
  sessionId: string,
  session: LiveSessionItem,
): SessionManifest {
  const startedAt = session.started_at;
  const durationMs = Math.max(0, session.duration_ms);
  const endedAt = Math.max(session.last_seen, startedAt + durationMs);
  const country = cleanOptionalText(session.country);
  const city = cleanOptionalText(session.city);
  const browser = cleanOptionalText(session.browser);
  const os = cleanOptionalText(session.os);
  const device = cleanOptionalText(session.device);
  const entryUrl = cleanOptionalText(session.entry_url);
  const attrs: SessionManifest["attrs"] = {
    ...(country !== undefined ? { country } : {}),
    ...(city !== undefined ? { city } : {}),
    ...(browser !== undefined ? { browser } : {}),
    ...(os !== undefined ? { os } : {}),
    ...(device !== undefined ? { device } : {}),
    ...(entryUrl !== undefined ? { entryUrl } : {}),
  };

  return {
    v: 1,
    sessionId,
    projectId,
    orgId: "live",
    startedAt,
    endedAt,
    durationMs,
    segments: [],
    timeline: [],
    counts: {
      batches: 0,
      events: 0,
      clicks: 0,
      errors: 0,
      rages: 0,
      navs: 0,
    },
    bytes: 0,
    flags: 0,
    attrs,
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function cleanOptionalText(value: string | null): string | undefined {
  const cleanValue = value?.trim();
  return cleanValue === undefined || cleanValue.length === 0 ? undefined : cleanValue;
}

function manifestPath(projectId: string, sessionId: string): string {
  return `/api/v1/projects/${encodePathPart(projectId)}/sessions/${encodePathPart(
    sessionId,
  )}/manifest`;
}

function matchesPath(input: Parameters<typeof fetch>[0], path: string): boolean {
  try {
    const url = new URL(requestUrl(input), window.location.href);
    return url.pathname === path && url.search.length === 0;
  } catch {
    return false;
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function clampTime(value: number, durationMs: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(0, value), Math.max(0, durationMs));
}

function formatCountry(country: string | undefined): string {
  if (country === undefined || country.trim().length === 0) return "Unknown";
  const code = country.trim().toUpperCase();
  return `${flagForCountry(code)} ${code}`;
}

function flagForCountry(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  const first = 0x1f1e6 + code.charCodeAt(0) - 65;
  const second = 0x1f1e6 + code.charCodeAt(1) - 65;
  return String.fromCodePoint(first, second);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}
