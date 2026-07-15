import { useEffect, useRef } from "react";
import { bucketActivity, type ActivityBucket } from "@orange-replay/player";
import type { SessionManifest } from "@orange-replay/shared/types";
import {
  buildJourneyBreadcrumbs,
  mapTimelineSidebarRows,
  type JourneyBreadcrumb,
} from "@/lib/replay-timeline";
import { JourneyBreadcrumbs } from "./replay-playback/journey-breadcrumbs";
import {
  buildDeadClickMarkers,
  buildErrorMarkers,
  buildRageMarkers,
  firstErrorOffset,
  type DeadClickMarker,
  type ErrorMarker,
  type RageMarker,
} from "./replay-playback/replay-markers";
import { ReplayControls } from "./replay-playback/replay-controls";
import { ReplayStage } from "./replay-playback/replay-stage";
import { TimelineSidebar } from "./replay-playback/timeline-sidebar";
import {
  useReplayPlayer,
  type ReplayPlayerOptions,
  type ReplayPlayerState,
} from "./use-replay-player";

interface ReplayWorkspaceProps extends ReplayPlayerOptions {
  onDeadClickCountChange?: (count: number) => void;
  onPlaybackStarted?: () => void;
  playerManifest?: SessionManifest;
}

export function ReplayWorkspace(props: ReplayWorkspaceProps) {
  const player = useReplayPlayer({
    ...props,
    liveReviewManifest: props.manifest,
    manifest: props.playerManifest ?? props.manifest,
  });
  const staticPlaybackData = {
    activityBuckets: bucketActivity(
      props.manifest.timeline,
      props.manifest.durationMs,
      100,
      props.manifest.startedAt,
    ),
    breadcrumbs: buildJourneyBreadcrumbs(props.manifest.attrs.entryUrl, props.manifest.timeline, {
      startedAt: props.manifest.startedAt,
      durationMs: props.manifest.durationMs,
    }),
    errorMarkers: buildErrorMarkers(props.manifest),
    firstErrorSeekMs: firstErrorOffset(props.manifest),
    rageMarkers: buildRageMarkers(props.manifest),
  };
  const deadClickData = {
    markers: buildDeadClickMarkers(props.manifest, player.state.deadClicks),
    rows: mapTimelineSidebarRows(
      props.manifest.timeline,
      {
        startedAt: props.manifest.startedAt,
        durationMs: props.manifest.durationMs,
      },
      player.state.deadClicks,
    ),
  };
  const startedSessionRef = useRef<string | null>(null);
  const seekFromTimeline = (timeMs: number) => player.actions.seekTo(timeMs, true);

  useEffect(() => {
    props.onDeadClickCountChange?.(player.state.deadClicks.length);
  }, [player.state.deadClicks.length, props.onDeadClickCountChange]);

  useEffect(() => {
    const started =
      player.state.playing || (props.mode === "live" && player.state.liveState.connected);
    if (!started || startedSessionRef.current === props.sessionId) return;
    startedSessionRef.current = props.sessionId;
    props.onPlaybackStarted?.();
  }, [
    player.state.liveState.connected,
    player.state.playing,
    props.mode,
    props.onPlaybackStarted,
    props.sessionId,
  ]);

  return (
    <section className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-[minmax(0,1fr)_304px]">
      <ReplayPlayerCard
        activityBuckets={staticPlaybackData.activityBuckets}
        breadcrumbs={staticPlaybackData.breadcrumbs}
        deadClickMarkers={deadClickData.markers}
        errorMarkers={staticPlaybackData.errorMarkers}
        firstErrorSeekMs={staticPlaybackData.firstErrorSeekMs}
        player={player}
        rageMarkers={staticPlaybackData.rageMarkers}
      />
      <TimelineSidebar
        disabled={player.values.isFollowing}
        onSeek={seekFromTimeline}
        rows={deadClickData.rows}
      />
    </section>
  );
}

function ReplayPlayerCard({
  activityBuckets,
  breadcrumbs,
  deadClickMarkers,
  errorMarkers,
  firstErrorSeekMs,
  player,
  rageMarkers,
}: {
  activityBuckets: ActivityBucket[];
  breadcrumbs: JourneyBreadcrumb[];
  deadClickMarkers: DeadClickMarker[];
  errorMarkers: ErrorMarker[];
  firstErrorSeekMs: number | null;
  player: ReplayPlayerState;
  rageMarkers: RageMarker[];
}) {
  return (
    <section className="lit overflow-hidden rounded-lg">
      <JourneyBreadcrumbs breadcrumbs={breadcrumbs} player={player} />
      <ReplayStage
        containerRef={player.containerRef}
        buffering={player.state.buffering}
        liveConnected={player.state.liveState.connected}
        isFollowing={player.values.isFollowing}
        playerError={player.state.playerError}
        ready={player.state.ready}
        retryPlayer={player.actions.retryPlayer}
        waitingForKeyframe={player.state.waitingForKeyframe}
      />
      <ReplayControls
        activityBuckets={activityBuckets}
        deadClickMarkers={deadClickMarkers}
        errorMarkers={errorMarkers}
        firstErrorSeekMs={firstErrorSeekMs}
        player={player}
        rageMarkers={rageMarkers}
      />
    </section>
  );
}
