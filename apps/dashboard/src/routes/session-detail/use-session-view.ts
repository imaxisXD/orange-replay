import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { applyLiveIndexToSnapshot } from "@orange-replay/player";
import type { BatchIndex, LiveSessionSnapshot, SessionManifest } from "@orange-replay/shared/types";
import type { SessionActivity, SessionDetailsState } from "@/lib/api";
import {
  loadSessionView,
  sessionStatePollIntervalMs,
  shouldPollSessionState,
  type ReplayMode,
} from "./session-detail-data";

export interface SessionViewState {
  activity: SessionActivity | null;
  detailsState: SessionDetailsState | null;
  displayedManifest: SessionManifest | null;
  error: unknown;
  loading: boolean;
  mode: ReplayMode;
  notFound: boolean;
  playerManifest: SessionManifest | null;
  refresh: () => void;
  onLiveEnded: () => void;
  onLiveFinalized: (manifest: SessionManifest) => void;
  onLiveIndex: (index: BatchIndex) => void;
  onLiveSnapshot: (snapshot: LiveSessionSnapshot) => void;
}

export function useSessionView({
  isDemo,
  projectId,
  sessionId,
}: {
  isDemo: boolean;
  projectId: string;
  sessionId: string;
}): SessionViewState {
  const scope = isDemo ? "demo" : "private";
  const queryClient = useQueryClient();
  const [adoptedManifest, setAdoptedManifest] = useState<{
    sessionId: string;
    manifest: SessionManifest;
  } | null>(null);
  const [liveState, setLiveState] = useState<{
    sessionId: string;
    snapshot: LiveSessionSnapshot;
  } | null>(null);
  const viewQuery = useQuery({
    enabled: sessionId.length > 0,
    queryKey: ["session-state", scope, projectId, sessionId],
    queryFn: ({ signal }) => loadSessionView(projectId, sessionId, signal),
    refetchInterval: (query) =>
      shouldPollSessionState(query.state.data?.detailsState, document.visibilityState)
        ? sessionStatePollIntervalMs
        : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const queryResult = viewQuery.data;
  const notFound = queryResult?.notFound ?? false;
  const localManifest = adoptedManifest?.sessionId === sessionId ? adoptedManifest.manifest : null;
  const serverManifest = queryResult?.manifest ?? null;
  const playerManifest = notFound
    ? null
    : queryResult?.mode === "recorded"
      ? serverManifest
      : (localManifest ?? serverManifest);
  const mode: ReplayMode =
    !notFound && (queryResult?.mode === "recorded" || localManifest !== null)
      ? "recorded"
      : (queryResult?.mode ?? "recorded");
  const snapshot =
    mode === "live" && liveState?.sessionId === sessionId ? liveState.snapshot : null;
  const displayedManifest = mergeLiveSnapshot(playerManifest, snapshot);
  const detailsState = queryResult?.detailsState ?? null;
  const activity =
    localManifest !== null && queryResult?.mode === "live"
      ? "finalizing"
      : (queryResult?.activity ?? null);
  const hasUsableManifest = playerManifest !== null;
  const refreshSessionState = viewQuery.refetch;

  function refresh(): void {
    void refreshSessionState();
  }

  function onLiveIndex(index: BatchIndex): void {
    setLiveState((current) =>
      current === null || current.sessionId !== index.s
        ? current
        : { ...current, snapshot: applyLiveIndexToSnapshot(current.snapshot, index) },
    );
  }

  function onLiveSnapshot(snapshot: LiveSessionSnapshot): void {
    setLiveState({ sessionId, snapshot });
  }

  function onLiveFinalized(manifest: SessionManifest): void {
    if (manifest.projectId !== projectId || manifest.sessionId !== sessionId) return;
    setAdoptedManifest({ sessionId, manifest });
    setLiveState(null);
    queryClient.setQueryData(
      ["session-state", scope, projectId, sessionId],
      (current: typeof queryResult) =>
        current === undefined || current.notFound
          ? current
          : {
              ...current,
              activity: current.detailsState === "exact" ? "complete" : "finalizing",
              manifest,
              mode: "recorded",
            },
    );
    void queryClient.invalidateQueries({ queryKey: ["session-heads", scope, projectId] });
    void queryClient.invalidateQueries({ queryKey: ["sessions", scope, projectId] });
    void refreshSessionState();
  }

  function onLiveEnded(): void {
    void refreshSessionState();
  }

  return {
    activity,
    detailsState,
    displayedManifest,
    error: !hasUsableManifest && !notFound ? viewQuery.error : null,
    loading: viewQuery.isPending && localManifest === null,
    mode,
    notFound,
    playerManifest,
    refresh,
    onLiveEnded,
    onLiveFinalized,
    onLiveIndex,
    onLiveSnapshot,
  };
}

function mergeLiveSnapshot(
  manifest: SessionManifest | null,
  snapshot: LiveSessionSnapshot | null,
): SessionManifest | null {
  if (manifest === null || snapshot === null) return manifest;
  return {
    ...manifest,
    endedAt: snapshot.endedAt,
    durationMs: snapshot.durationMs,
    timeline: snapshot.timeline,
    counts: snapshot.counts,
  };
}
