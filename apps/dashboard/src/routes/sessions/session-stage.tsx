import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { SessionManifest } from "@orange-replay/shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/status-pill";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, type SessionActivity, type SessionDetailsState } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { IconSwap } from "@/components/ui/icon-swap";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronRight,
  Clock,
  Copy,
  EyeOff,
  Inbox,
} from "@/lib/icon-map";
import { ReplayWorkspace } from "../session-detail/replay-playback";
import { useSessionView } from "../session-detail/use-session-view";
import { entryPath } from "./session-card";

/**
 * Right pane of the two-pane sessions view: the selected session plays here
 * without leaving the page. Deep links stay on the detail route.
 */
export function SessionStage({
  hasNext,
  hasPrev,
  isDemo,
  isWatched,
  onBack,
  onMarkUnwatched,
  onPlaybackStarted,
  onStep,
  projectId,
  railEmpty,
  sessionId,
}: {
  hasNext: boolean;
  hasPrev: boolean;
  isDemo: boolean;
  isWatched: boolean;
  onBack: () => void;
  onMarkUnwatched: () => void;
  onPlaybackStarted: () => void;
  onStep: (delta: 1 | -1) => void;
  projectId: string;
  railEmpty: boolean;
  sessionId: string | undefined;
}) {
  if (sessionId === undefined) {
    return (
      <Empty className="min-h-90 border border-dashed border-dash">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {railEmpty ? <Inbox aria-hidden /> : <ArrowLeft aria-hidden />}
          </EmptyMedia>
          <EmptyTitle>
            {railEmpty ? "Nothing to watch yet" : "Select a session to watch"}
          </EmptyTitle>
          <EmptyDescription>
            {railEmpty
              ? "When the list has sessions, pick one and it plays here."
              : "Pick one from the list — it plays here instantly. Amber dots mark sessions you have not watched yet."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="stage-in" key={sessionId}>
      <SelectedSession
        hasNext={hasNext}
        hasPrev={hasPrev}
        isDemo={isDemo}
        isWatched={isWatched}
        onBack={onBack}
        onMarkUnwatched={onMarkUnwatched}
        onPlaybackStarted={onPlaybackStarted}
        onStep={onStep}
        projectId={projectId}
        sessionId={sessionId}
      />
    </div>
  );
}

function SelectedSession({
  hasNext,
  hasPrev,
  isDemo,
  isWatched,
  onBack,
  onMarkUnwatched,
  onPlaybackStarted,
  onStep,
  projectId,
  sessionId,
}: {
  hasNext: boolean;
  hasPrev: boolean;
  isDemo: boolean;
  isWatched: boolean;
  onBack: () => void;
  onMarkUnwatched: () => void;
  onPlaybackStarted: () => void;
  onStep: (delta: 1 | -1) => void;
  projectId: string;
  sessionId: string;
}) {
  const sessionView = useSessionView({ isDemo, projectId, sessionId });
  const manifest = sessionView.displayedManifest;
  const playerManifest = sessionView.playerManifest;
  const error = sessionView.error === null ? "" : readErrorMessage(sessionView.error);

  if (sessionView.loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-90 w-full rounded-lg" />
      </div>
    );
  }

  if (error.length > 0 || sessionView.notFound || manifest === null || playerManifest === null) {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden />
        <AlertTitle>
          {sessionView.notFound ? "Session not found" : "Could not load session"}
        </AlertTitle>
        <AlertDescription>
          <p>
            {sessionView.notFound
              ? "This session is not available."
              : error || "The request failed. Try again in a moment."}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {!sessionView.notFound && (
              <Button onClick={sessionView.refresh} size="sm" variant="secondary">
                Try again
              </Button>
            )}
            {hasNext && (
              <Button onClick={() => onStep(1)} size="sm" variant="secondary">
                Next session
              </Button>
            )}
            <Button onClick={onBack} size="sm" variant="ghost">
              Back to sessions
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  const hasReplay = manifest.segments.length > 0 || sessionView.mode === "live";

  return (
    <div className="flex flex-col gap-3">
      <StageHeader
        hasNext={hasNext}
        hasPrev={hasPrev}
        isDemo={isDemo}
        isWatched={isWatched}
        activity={sessionView.activity}
        detailsState={sessionView.detailsState}
        manifest={manifest}
        onMarkUnwatched={onMarkUnwatched}
        onStep={onStep}
        projectId={projectId}
        sessionId={sessionId}
      />
      {hasReplay ? (
        <ReplayWorkspace
          isDemo={isDemo}
          manifest={manifest}
          mode={sessionView.mode}
          onLiveEnded={sessionView.onLiveEnded}
          onLiveFinalized={sessionView.onLiveFinalized}
          onLiveIndex={sessionView.onLiveIndex}
          onLiveSnapshot={sessionView.onLiveSnapshot}
          onPlaybackStarted={onPlaybackStarted}
          playerManifest={playerManifest}
          projectId={projectId}
          reviewLiveHistory={sessionView.activity === "idle"}
          sessionId={sessionId}
        />
      ) : (
        <Empty className="min-h-90 border border-dashed border-dash">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <EyeOff aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No replay captured for this session</EmptyTitle>
            <EmptyDescription>
              Metadata only — the recording produced no playable segments, so there is nothing to
              watch here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">
              {hasNext && (
                <Button onClick={() => onStep(1)} variant="secondary">
                  Try next session
                </Button>
              )}
              <Button onClick={onBack} variant="ghost">
                Back to sessions
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}

function StageHeader({
  activity,
  detailsState,
  hasNext,
  hasPrev,
  isDemo,
  isWatched,
  manifest,
  onMarkUnwatched,
  onStep,
  projectId,
  sessionId,
}: {
  activity: SessionActivity | null;
  detailsState: SessionDetailsState | null;
  hasNext: boolean;
  hasPrev: boolean;
  isDemo: boolean;
  isWatched: boolean;
  manifest: SessionManifest;
  onMarkUnwatched: () => void;
  onStep: (delta: 1 | -1) => void;
  projectId: string;
  sessionId: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copySessionId(): Promise<void> {
    if (copied) {
      return;
    }

    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1">
        <span className="truncate text-[13px] font-medium text-foreground">
          {entryPath(manifest.attrs.entryUrl ?? null)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5" title="Session duration">
          <Clock aria-hidden className="size-3.5 shrink-0 text-amber" />
          <span className="text-[11px] text-dim">Duration</span>
          <span className="font-mono text-[12px] tabular-nums text-foreground">
            {formatDuration(manifest.durationMs)}
          </span>
        </span>
        {activity === "live" ? (
          <StatusPill kind="ok">Live</StatusPill>
        ) : detailsState === "provisional" ? (
          <StatusPill kind="neutral">Final details pending</StatusPill>
        ) : null}
        <Tooltip content={copied ? "Copied session ID" : "Copy session ID"}>
          <Button
            aria-label={copied ? "Session ID copied" : "Copy session ID"}
            className="hidden h-6 shrink-0 gap-1.5 px-2 font-mono text-[11px] text-muted-foreground lg:inline-flex"
            onClick={() => void copySessionId()}
            size="sm"
            variant="secondary"
          >
            <span className="flex items-center gap-1.5">
              <span className="font-sans text-[11px] text-dim">Session ID</span>
              <span>{sessionId.slice(0, 8)}…</span>
              <IconSwap className="size-3 shrink-0" swapKey={copied ? "check" : "copy"}>
                {copied ? (
                  <Check aria-hidden className="size-3 text-success" />
                ) : (
                  <Copy aria-hidden className="size-3 opacity-70" />
                )}
              </IconSwap>
            </span>
          </Button>
        </Tooltip>
      </div>
      <div className="flex w-full shrink-0 items-center justify-between gap-1 sm:w-auto sm:justify-start">
        <Tooltip content="Previous session (↑ or k in the list)">
          <Button
            aria-label="Previous session"
            className="text-muted-foreground hover:text-foreground"
            disabled={!hasPrev}
            onClick={() => onStep(-1)}
            size="icon-sm"
            variant="secondary"
          >
            <ChevronRight aria-hidden className="size-4 rotate-180" />
          </Button>
        </Tooltip>
        <Tooltip content="Next session (↓ or j in the list)">
          <Button
            aria-label="Next session"
            className="text-muted-foreground hover:text-foreground"
            disabled={!hasNext}
            onClick={() => onStep(1)}
            size="icon-sm"
            variant="secondary"
          >
            <ChevronRight aria-hidden className="size-4" />
          </Button>
        </Tooltip>
        {isWatched && (
          <Button
            className="hidden text-muted-foreground hover:text-foreground sm:inline-flex"
            onClick={onMarkUnwatched}
            size="sm"
            variant="secondary"
          >
            Mark unwatched
          </Button>
        )}
        <Button asChild size="sm" variant="secondary">
          {isDemo ? (
            <Link params={{ sessionId }} to="/demo/sessions/$sessionId">
              Open full view
            </Link>
          ) : (
            <Link params={{ projectId, sessionId }} to="/projects/$projectId/sessions/$sessionId">
              Open full view
            </Link>
          )}
        </Button>
      </div>
    </div>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "network_error") return error.message;
    if (error.status >= 500) return "The replay service is unavailable. Try again in a moment.";
    return error.message.replaceAll("_", " ");
  }
  if (error instanceof Error) return error.message;
  return "The request failed. Try again in a moment.";
}
