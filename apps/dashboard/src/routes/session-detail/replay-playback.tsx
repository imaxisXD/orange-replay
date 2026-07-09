import { useImperativeHandle, useRef } from "react";
import type { PlayerErrorEvent } from "@orange-replay/player";
import type { SessionManifest } from "@orange-replay/shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { formatDuration } from "@/lib/format";
import { AlertCircle } from "@/lib/icon-map";
import {
  buildTimelineTickBuckets,
  mapTimelineSidebarRows,
  timelineProgressPercent,
  type TimelineDot,
  type TimelineSidebarRow,
} from "@/lib/replay-timeline";
import {
  useReplayPlayer,
  type ReplayPlayerController,
  type ReplayPlayerOptions,
  type ReplayPlayerState,
} from "./use-replay-player";

interface ErrorMarker {
  id: string;
  leftPercent: number;
}

export function ReplayWorkspace(props: ReplayPlayerOptions) {
  const playerControllerRef = useRef<ReplayPlayerController>(null);
  const rows = mapTimelineSidebarRows(props.manifest.timeline, {
    startedAt: props.manifest.startedAt,
    durationMs: props.manifest.durationMs,
  });
  const timelineBuckets = buildTimelineTickBuckets(props.manifest.timeline, {
    startedAt: props.manifest.startedAt,
    durationMs: props.manifest.durationMs,
    bucketCount: 36,
  });
  const errorMarkers = buildErrorMarkers(props.manifest);

  return (
    <section className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1fr_320px]">
      <ReplayPlayerCard
        controllerRef={playerControllerRef}
        errorMarkers={errorMarkers}
        timelineBuckets={timelineBuckets}
        {...props}
      />
      <TimelineSidebar
        onSeek={(timeMs) => playerControllerRef.current?.seekTo(timeMs, true)}
        rows={rows}
      />
    </section>
  );
}

function ReplayPlayerCard({
  controllerRef,
  errorMarkers,
  timelineBuckets,
  ...props
}: ReplayPlayerOptions & {
  controllerRef: React.Ref<ReplayPlayerController>;
  errorMarkers: ErrorMarker[];
  timelineBuckets: ReturnType<typeof buildTimelineTickBuckets>;
}) {
  const player = useReplayPlayer(props);
  useImperativeHandle(controllerRef, () => ({ seekTo: player.actions.seekTo }));

  return (
    <section className="lit overflow-hidden rounded-lg">
      <ReplayStage
        containerRef={player.containerRef}
        buffering={player.state.buffering}
        isFollowing={player.values.isFollowing}
        playerError={player.state.playerError}
        ready={player.state.ready}
        retryPlayer={player.actions.retryPlayer}
        waitingForKeyframe={player.state.waitingForKeyframe}
      />
      <ReplayControls
        errorMarkers={errorMarkers}
        player={player}
        timelineBuckets={timelineBuckets}
      />
    </section>
  );
}

function ReplayStage({
  buffering,
  containerRef,
  isFollowing,
  playerError,
  ready,
  retryPlayer,
  waitingForKeyframe,
}: {
  buffering: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  isFollowing: boolean;
  playerError: PlayerErrorEvent | null;
  ready: boolean;
  retryPlayer: () => void;
  waitingForKeyframe: boolean;
}) {
  return (
    <div
      className="relative aspect-video min-h-90 overflow-hidden bg-background"
      data-testid="replay-stage"
    >
      <div ref={containerRef} className="absolute inset-0 overflow-hidden" />

      {!ready && playerError === null && (
        <div className="absolute inset-0 z-20 p-4">
          <Skeleton className="h-full w-full rounded-md" />
        </div>
      )}

      {ready && isFollowing && waitingForKeyframe && playerError === null && (
        <ReplayOverlay
          dotClassName="live-pulse size-2.25 rounded-full bg-success"
          label="Connected live - waiting for the next keyframe..."
        />
      )}

      {ready && buffering && !waitingForKeyframe && playerError === null && (
        <ReplayOverlay
          dotClassName="size-8 animate-spin rounded-full border border-dash border-t-amber"
          label="Buffering..."
        />
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
  );
}

function ReplayControls({
  errorMarkers,
  player,
  timelineBuckets,
}: {
  errorMarkers: ErrorMarker[];
  player: ReplayPlayerState;
  timelineBuckets: ReturnType<typeof buildTimelineTickBuckets>;
}) {
  const { currentMs, flashKey, playing, skipIdle, speed } = player.state;
  const { isFollowing, playheadPercent, timelineDurationMs } = player.values;

  return (
    <div className="flex items-center gap-3.5 overflow-x-auto border-t border-dashed border-dash px-4 py-3.25">
      <button
        aria-label={playing ? "Pause replay" : "Play replay"}
        className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-foreground text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-amber"
        onClick={player.actions.togglePlayback}
        type="button"
      >
        <IconSwap swapKey={playing ? "pause" : "play"}>
          <PlayPauseShape playing={playing} />
        </IconSwap>
      </button>

      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
        {formatDuration(currentMs)}
      </span>

      <div
        aria-label="Replay timeline"
        aria-valuemax={Math.round(timelineDurationMs)}
        aria-valuemin={0}
        aria-valuenow={Math.round(currentMs)}
        className="relative h-6.5 min-w-40 flex-1 cursor-pointer touch-none"
        onPointerCancel={player.actions.stopTimelineDrag}
        onPointerDown={player.actions.startTimelineDrag}
        onPointerMove={player.actions.moveTimelineDrag}
        onPointerUp={player.actions.stopTimelineDrag}
        role="slider"
        tabIndex={0}
      >
        <div className="absolute right-0 left-0 top-3 border-t border-dashed border-dash" />
        <TimelineBuckets buckets={timelineBuckets} />
        <ErrorMarkers markers={errorMarkers} />
        <Playhead flashKey={flashKey} leftPercent={playheadPercent} />
      </div>

      <TimelineEnd isFollowing={isFollowing} timelineDurationMs={timelineDurationMs} />

      {!isFollowing && (
        <Button
          className="font-mono text-[12.5px] text-muted-foreground hover:text-foreground"
          onClick={player.actions.cycleSpeed}
          size="sm"
          variant="secondary"
        >
          {speed}x
        </Button>
      )}

      <Switch
        checked={skipIdle}
        className="px-0 py-0 [&>span:last-child]:text-[11.5px]"
        label="Skip idle"
        onToggle={player.actions.toggleSkipIdle}
      />

      <div className="flex gap-1.25">
        <kbd className="rounded-[5px] border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
          ←
        </kbd>
        <kbd className="rounded-[5px] border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
          →
        </kbd>
        <kbd className="rounded-[5px] border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
          space
        </kbd>
      </div>
    </div>
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
    <aside className="lit flex h-full min-h-0 flex-col rounded-lg px-4.5 py-4 max-lg:max-h-90">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold">Timeline</h2>
        <span className="text-[11.5px] text-dim">{rows.length} events</span>
      </div>

      {rows.length === 0 ? (
        <div className="mt-4 flex min-h-35 items-center justify-center rounded-lg border border-dashed border-dash text-[12.5px] text-muted-foreground">
          No indexed events.
        </div>
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          {rows.map((row) => (
            <button
              className="flex w-full items-center gap-2.5 border-b border-dashed border-dash py-2 text-left outline-none transition-colors last:border-b-0 hover:bg-hover focus-visible:ring-1 focus-visible:ring-amber"
              key={row.id}
              onClick={() => onSeek(row.offsetMs)}
              type="button"
            >
              <span className={`size-1.5 shrink-0 rounded-full ${dotClass(row.dot)}`} />
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

function TimelineBuckets({ buckets }: { buckets: ReturnType<typeof buildTimelineTickBuckets> }) {
  return (
    <>
      {buckets.flatMap((bucket) =>
        bucket.count === 0
          ? []
          : [
              <span
                aria-hidden
                className="absolute bottom-1 w-1 rounded-[1.5px] bg-timeline-bar"
                key={bucket.index}
                style={{
                  height: `${bucket.heightPx}px`,
                  left: `${bucket.leftPercent}%`,
                }}
              />,
            ],
      )}
    </>
  );
}

function ErrorMarkers({ markers }: { markers: ErrorMarker[] }) {
  return (
    <>
      {markers.map((marker) => (
        <span
          aria-hidden
          className="absolute top-0 h-full w-0.5 bg-danger shadow-[0_0_8px_var(--danger-shadow)]"
          key={marker.id}
          style={{ left: `${marker.leftPercent}%` }}
        />
      ))}
    </>
  );
}

function Playhead({ flashKey, leftPercent }: { flashKey: number; leftPercent: number }) {
  return (
    <span
      aria-hidden
      className={
        flashKey > 0
          ? "timeline-playhead-flash absolute top-0 bottom-0 w-0.5 bg-amber shadow-[0_0_9px_var(--amber-shadow)] after:absolute after:-top-0.75 after:-left-0.75 after:size-2 after:rounded-full after:bg-amber"
          : "absolute top-0 bottom-0 w-0.5 bg-amber shadow-[0_0_9px_var(--amber-shadow)] after:absolute after:-top-0.75 after:-left-0.75 after:size-2 after:rounded-full after:bg-amber"
      }
      key={flashKey}
      style={{ left: `${leftPercent}%` }}
    />
  );
}

function TimelineEnd({
  isFollowing,
  timelineDurationMs,
}: {
  isFollowing: boolean;
  timelineDurationMs: number;
}) {
  if (isFollowing) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] font-medium text-success">
        <span className="live-pulse size-1.75 rounded-full bg-success" />
        LIVE
      </span>
    );
  }

  return (
    <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
      {formatDuration(timelineDurationMs)}
    </span>
  );
}

function ReplayOverlay({ dotClassName, label }: { dotClassName: string; label: string }) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background/72">
      <span className={dotClassName} />
      <span className="text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}

function PlayPauseShape({ playing }: { playing: boolean }) {
  if (playing) {
    return (
      <span className="flex items-center gap-1" aria-hidden>
        <span className="h-3.5 w-1 rounded-[1px] bg-background" />
        <span className="h-3.5 w-1 rounded-[1px] bg-background" />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className="ml-0.5 h-0 w-0 border-y-7 border-l-10 border-y-transparent border-l-background"
    />
  );
}

function dotClass(dot: TimelineDot): string {
  if (dot === "blue") return "bg-player-blue";
  if (dot === "danger") return "bg-danger";
  if (dot === "amber") return "bg-amber";
  return "bg-teal";
}

function buildErrorMarkers(manifest: SessionManifest): ErrorMarker[] {
  const markers: ErrorMarker[] = [];
  for (const event of manifest.timeline) {
    if (event.k !== "error") continue;

    markers.push({
      id: `${event.t}-${event.d ?? "error"}`,
      leftPercent: timelineProgressPercent(event.t - manifest.startedAt, manifest.durationMs),
    });
  }
  return markers;
}
