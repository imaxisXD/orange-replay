import type { ActivityBucket } from "@orange-replay/player";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { Switch } from "@/components/ui/switch";
import { formatDuration } from "@/lib/format";
import { AlertCircle, Angry } from "@/lib/icon-map";
import type { ReplayPlayerState } from "../use-replay-player";
import type { DeadClickMarker, ErrorMarker, RageMarker } from "./replay-markers";

// Above this per-kind density the icon caps would overlap into noise; the
// position lines still mark every event.
const MAX_ICON_MARKERS = 24;

export function ReplayControls({
  activityBuckets,
  deadClickMarkers,
  errorMarkers,
  firstErrorSeekMs,
  player,
  rageMarkers,
}: {
  activityBuckets: ActivityBucket[];
  deadClickMarkers: DeadClickMarker[];
  errorMarkers: ErrorMarker[];
  firstErrorSeekMs: number | null;
  player: ReplayPlayerState;
  rageMarkers: RageMarker[];
}) {
  const { currentMs, flashKey, playing, skipIdle, speed } = player.state;
  const { isFollowing, playheadPercent, timelineDurationMs } = player.values;

  return (
    <div className="flex items-center gap-3.5 overflow-x-auto border-t border-dashed border-dash px-4 py-3.25">
      {!isFollowing && (
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
      )}

      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
        {formatDuration(currentMs)}
      </span>

      <div
        aria-label="Replay timeline"
        aria-disabled={isFollowing}
        aria-valuemax={Math.round(timelineDurationMs)}
        aria-valuemin={0}
        aria-valuenow={Math.round(currentMs)}
        aria-valuetext={`${formatDuration(currentMs)} of ${formatDuration(timelineDurationMs)}`}
        className={`relative h-6.5 min-w-40 flex-1 touch-none ${isFollowing ? "cursor-default" : "cursor-pointer"}`}
        onKeyDown={(event) => {
          if (isFollowing) return;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            player.actions.seekTo(currentMs - 5_000);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            player.actions.seekTo(currentMs + 5_000);
          } else if (event.key === "Home") {
            event.preventDefault();
            player.actions.seekTo(0);
          } else if (event.key === "End") {
            event.preventDefault();
            player.actions.seekTo(timelineDurationMs);
          } else if (event.key === " " || event.key === "Spacebar") {
            event.preventDefault();
            player.actions.togglePlayback();
          }
        }}
        onPointerCancel={isFollowing ? undefined : player.actions.stopTimelineDrag}
        onPointerDown={isFollowing ? undefined : player.actions.startTimelineDrag}
        onPointerMove={isFollowing ? undefined : player.actions.moveTimelineDrag}
        onPointerUp={isFollowing ? undefined : player.actions.stopTimelineDrag}
        role="slider"
        tabIndex={0}
      >
        <div className="absolute right-0 left-0 top-3 border-t border-dashed border-dash" />
        <ActivityHeatStrip buckets={activityBuckets} />
        <ErrorMarkers markers={errorMarkers} />
        <RageMarkers markers={rageMarkers} />
        <DeadClickMarkers markers={deadClickMarkers} />
        <Playhead flashKey={flashKey} leftPercent={playheadPercent} />
      </div>

      <TimelineEnd isFollowing={isFollowing} timelineDurationMs={timelineDurationMs} />

      {!isFollowing && firstErrorSeekMs !== null && (
        <Button
          className="h-7 gap-1.5 px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
          data-testid="first-error-button"
          onClick={() => player.actions.seekAndPlay(firstErrorSeekMs, true)}
          size="sm"
          variant="ghost"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-danger" />
          First error
        </Button>
      )}

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

      {!isFollowing && (
        <Switch
          checked={skipIdle}
          className="px-0 py-0 [&>span:last-child]:text-[11.5px]"
          label="Skip idle"
          onToggle={player.actions.toggleSkipIdle}
        />
      )}

      {!isFollowing && (
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
      )}
    </div>
  );
}

function ActivityHeatStrip({ buckets }: { buckets: ActivityBucket[] }) {
  return (
    <span
      aria-label="Session activity"
      className="absolute top-1 right-0 left-0 flex h-1 gap-px overflow-hidden rounded-full"
      data-testid="activity-heat-strip"
      role="img"
      title="Activity: brighter colors mean more events"
    >
      {buckets.map((bucket) => (
        <span
          aria-hidden
          className="min-w-0 flex-1"
          data-activity-count={bucket.count}
          key={bucket.index}
          style={{ backgroundColor: activityBucketColor(bucket) }}
          title={bucket.count === 1 ? "1 event" : `${bucket.count} events`}
        />
      ))}
    </span>
  );
}

function DeadClickMarkers({ markers }: { markers: DeadClickMarker[] }) {
  return (
    <>
      {markers.map((marker) => (
        <span
          aria-hidden
          className="absolute top-2 size-2 -translate-x-1/2 rounded-full border-2 border-dim bg-background"
          data-testid="dead-click-marker"
          key={marker.id}
          style={{ left: `${marker.leftPercent}%` }}
          title="Dead click"
        />
      ))}
    </>
  );
}

function ErrorMarkers({ markers }: { markers: ErrorMarker[] }) {
  const showIcons = markers.length <= MAX_ICON_MARKERS;
  return (
    <>
      {markers.map((marker) => (
        <span
          aria-hidden
          className="absolute top-0 h-full w-0.5 bg-danger shadow-[0_0_8px_var(--danger-shadow)]"
          key={marker.id}
          style={{ left: `${marker.leftPercent}%` }}
          title={`Error at ${marker.offsetLabel}`}
        >
          {showIcons && (
            <AlertCircle className="pointer-events-none absolute -bottom-0.5 left-1/2 size-3 -translate-x-1/2 text-danger" />
          )}
        </span>
      ))}
    </>
  );
}

function RageMarkers({ markers }: { markers: RageMarker[] }) {
  const showIcons = markers.length <= MAX_ICON_MARKERS;
  return (
    <>
      {markers.map((marker) => (
        <span
          aria-hidden
          className="absolute top-2 h-2.5 w-0.5 bg-amber shadow-[0_0_8px_var(--amber-shadow)]"
          data-testid="rage-marker"
          key={marker.id}
          style={{ left: `${marker.leftPercent}%` }}
          title={`Rage clicks at ${marker.offsetLabel}`}
        >
          {showIcons && (
            <Angry className="pointer-events-none absolute -bottom-3 left-1/2 size-3 -translate-x-1/2 text-amber" />
          )}
        </span>
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

function activityBucketColor(bucket: ActivityBucket): string {
  if (bucket.count === 0) return "transparent";
  if (bucket.intensity <= 0.25) return "#113732";
  if (bucket.intensity <= 0.5) return "#14746a";
  if (bucket.intensity <= 0.75) return "#2dd4bf";
  if (bucket.intensity < 1) return "#f5a623";
  return "#f4534e";
}
