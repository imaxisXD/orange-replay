import type { ActivityBucket } from "@orange-replay/player";
import { Button } from "@/components/ui/button";
import { MorphTooltip } from "@/components/ui/morph-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  const { actions, state, timelineRef, values } = player;
  const { currentMs, flashKey, playing, skipIdle, speed } = state;
  const { isFollowing, playheadPercent, timelineDurationMs } = values;

  return (
    <ScrollArea
      className="border-t border-dashed border-dash"
      orientation="horizontal"
      viewportClassName="scroll-fade-x"
    >
      <div className="flex min-w-full w-max items-center gap-3.5 px-4 py-3.25">
        {!isFollowing && (
          <ReplayPlayPauseControl onToggle={actions.togglePlayback} playing={playing} />
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
          className={`group relative h-10 min-w-40 flex-1 touch-none ${isFollowing ? "cursor-default" : "cursor-pointer"}`}
          onKeyDown={(event) => {
            if (isFollowing) return;
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              actions.seekTo(currentMs - 5_000);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              actions.seekTo(currentMs + 5_000);
            } else if (event.key === "Home") {
              event.preventDefault();
              actions.seekTo(0);
            } else if (event.key === "End") {
              event.preventDefault();
              actions.seekTo(timelineDurationMs);
            } else if (event.key === " " || event.key === "Spacebar") {
              event.preventDefault();
              actions.togglePlayback();
            }
          }}
          onPointerCancel={isFollowing ? undefined : actions.stopTimelineDrag}
          onPointerDown={isFollowing ? undefined : actions.startTimelineDrag}
          onPointerMove={isFollowing ? undefined : actions.moveTimelineDrag}
          onPointerUp={isFollowing ? undefined : actions.stopTimelineDrag}
          ref={timelineRef}
          role="slider"
          style={{ "--playhead": `${playheadPercent}%` } as React.CSSProperties}
          tabIndex={0}
        >
          <div className="absolute right-0 left-0 top-5 border-t border-dashed border-dash" />
          <div
            aria-hidden
            className="pointer-events-none absolute top-[17px] left-0 h-1.5 rounded-full bg-amber/15"
            style={{ width: "var(--playhead, 0%)" }}
          />
          <ActivityHeatStrip buckets={activityBuckets} />
          <ErrorMarkers markers={errorMarkers} />
          <RageMarkers markers={rageMarkers} />
          <DeadClickMarkers markers={deadClickMarkers} />
          <Playhead flashKey={flashKey} />
        </div>

        <TimelineEnd isFollowing={isFollowing} timelineDurationMs={timelineDurationMs} />

        {!isFollowing && firstErrorSeekMs !== null && (
          <Button
            className="h-7 gap-1.5 px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
            data-testid="first-error-button"
            onClick={() => actions.seekAndPlay(firstErrorSeekMs, true)}
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
            onClick={actions.cycleSpeed}
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
            onToggle={actions.toggleSkipIdle}
            size="small"
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
    </ScrollArea>
  );
}

export function ReplayPlayPauseControl({
  onToggle,
  playing,
}: {
  onToggle: () => void;
  playing: boolean;
}) {
  const action = playing ? "Pause" : "Play";

  return (
    <MorphTooltip.Provider delay={0}>
      <MorphTooltip.Root size="sm">
        <MorphTooltip.Trigger
          aria-label={`${action} replay`}
          render={
            <button
              className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-transparent text-foreground outline-none transition-[background-color,color,opacity] duration-150 ease-out hover:opacity-90 focus-visible:ring-1 focus-visible:ring-amber data-[surface-visible]:bg-foreground data-[surface-visible]:text-background"
              onClick={onToggle}
              type="button"
            />
          }
        >
          <PlayPauseShape playing={playing} />
        </MorphTooltip.Trigger>
        <MorphTooltip.Portal>
          <MorphTooltip.Positioner side="top">
            <MorphTooltip.Popup>
              <MorphTooltip.Arrow />
              <MorphTooltip.Viewport>
                <MorphTooltip.Label>{action} replay · Space</MorphTooltip.Label>
              </MorphTooltip.Viewport>
            </MorphTooltip.Popup>
          </MorphTooltip.Positioner>
        </MorphTooltip.Portal>
      </MorphTooltip.Root>
    </MorphTooltip.Provider>
  );
}

function ActivityHeatStrip({ buckets }: { buckets: ActivityBucket[] }) {
  return (
    <span
      aria-label="Session activity"
      className="absolute top-[17px] right-0 left-0 flex h-1.5 gap-px"
      data-testid="activity-heat-strip"
      role="img"
      title="Activity: brighter colors mean more events"
    >
      {buckets.map((bucket) => (
        <span
          aria-hidden
          className="relative min-w-0 flex-1 rounded-[1px] transition-transform duration-150 ease-out hover:z-10 hover:scale-y-[1.8] hover:brightness-125 motion-reduce:transition-none motion-reduce:hover:scale-y-100"
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
          className="absolute top-4 size-2 -translate-x-1/2 rounded-full border-2 border-dim bg-background transition-transform duration-150 ease-out before:absolute before:-inset-2 before:content-[''] hover:z-10 hover:-translate-x-1/2 hover:scale-150 motion-reduce:transition-none motion-reduce:hover:scale-100"
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
          className="absolute top-[13px] h-3.5 w-0.5 bg-danger shadow-[0_0_8px_var(--danger-shadow)] transition-transform duration-150 ease-out before:absolute before:-inset-x-2 before:-inset-y-1.5 before:content-[''] hover:z-10 hover:scale-[1.45] motion-reduce:transition-none motion-reduce:hover:scale-100"
          key={marker.id}
          style={{ left: `${marker.leftPercent}%` }}
          title={`Error at ${marker.offsetLabel}`}
        >
          {showIcons && (
            <AlertCircle className="pointer-events-none absolute -bottom-3 left-1/2 size-3 -translate-x-1/2 text-danger" />
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
          className="absolute top-[15px] h-2.5 w-0.5 bg-amber shadow-[0_0_8px_var(--amber-shadow)] transition-transform duration-150 ease-out before:absolute before:-inset-x-2 before:-inset-y-1.5 before:content-[''] hover:z-10 hover:scale-[1.45] motion-reduce:transition-none motion-reduce:hover:scale-100"
          data-testid="rage-marker"
          key={marker.id}
          style={{ left: `${marker.leftPercent}%` }}
          title={`Rage clicks at ${marker.offsetLabel}`}
        >
          {showIcons && (
            <Angry className="pointer-events-none absolute -bottom-3.5 left-1/2 size-3 -translate-x-1/2 text-amber" />
          )}
        </span>
      ))}
    </>
  );
}

function Playhead({ flashKey }: { flashKey: number }) {
  // The span is only the positioning anchor; the visible playhead is the amber
  // pill riding the track — no full-height stem line. The ::before pad widens
  // the hover zone, and position comes from the slider's --playhead CSS var,
  // driven per frame outside React.
  return (
    <span
      aria-hidden
      className={`${flashKey > 0 ? "timeline-playhead-flash " : ""}absolute top-1 bottom-1 w-0.5 cursor-grab active:cursor-grabbing group-aria-disabled:cursor-default before:absolute before:inset-y-0 before:-inset-x-2.5 before:content-[''] after:absolute after:top-2 after:left-1/2 after:h-4 after:w-[3.5px] after:-translate-x-1/2 after:rounded-full after:bg-amber after:shadow-[0_0_8px_var(--amber-shadow)] after:transition-[scale,box-shadow] after:duration-150 after:ease-out after:content-[''] hover:after:scale-[1.45] hover:after:shadow-[0_0_12px_var(--amber-shadow)] group-aria-disabled:hover:after:scale-100 motion-reduce:after:transition-none`}
      key={flashKey}
      style={{ left: "var(--playhead, 0%)" }}
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
        <span className="h-3.5 w-1 rounded-[1px] bg-current" />
        <span className="h-3.5 w-1 rounded-[1px] bg-current" />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className="ml-0.5 h-0 w-0 border-y-7 border-l-10 border-y-transparent border-l-current"
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
