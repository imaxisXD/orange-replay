import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SessionManifest } from "@orange-replay/shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { AlertCircle, ArrowLeft, ChevronRight, EyeOff, Inbox } from "@/lib/icon-map";
import { markSessionWatched } from "@/lib/watched";
import { ReplayWorkspace } from "../session-detail/replay-playback";
import { loadSessionManifest } from "../session-detail/session-detail-data";
import { entryPath } from "./session-card";

/**
 * Right pane of the two-pane sessions view: the selected session plays here
 * without leaving the page. Deep links stay on the detail route.
 */
export function SessionStage({
  hasNext,
  hasPrev,
  isDemo,
  onStep,
  projectId,
  railEmpty,
  sessionId,
}: {
  hasNext: boolean;
  hasPrev: boolean;
  isDemo: boolean;
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
  onStep,
  projectId,
  sessionId,
}: {
  hasNext: boolean;
  hasPrev: boolean;
  isDemo: boolean;
  onStep: (delta: 1 | -1) => void;
  projectId: string;
  sessionId: string;
}) {
  const manifestQuery = useQuery({
    queryKey: ["session-manifest", isDemo ? "demo" : "private", projectId, sessionId],
    queryFn: ({ signal }) => loadSessionManifest(projectId, sessionId, signal),
  });

  // Deep-linked selections count as watched too, once the session actually loads.
  useEffect(() => {
    if (manifestQuery.data?.manifest !== undefined && manifestQuery.data.manifest !== null) {
      markSessionWatched(projectId, sessionId);
    }
  }, [manifestQuery.data, projectId, sessionId]);

  const manifest = manifestQuery.data?.manifest ?? null;
  const mode = manifestQuery.data?.mode ?? "recorded";
  const notFound = manifestQuery.data?.notFound ?? false;
  const error = manifestQuery.error === null ? "" : readErrorMessage(manifestQuery.error);

  if (manifestQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-90 w-full rounded-lg" />
      </div>
    );
  }

  if (error.length > 0 || notFound || manifest === null) {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden />
        <AlertTitle>{notFound ? "Session not found" : "Could not load session"}</AlertTitle>
        <AlertDescription>
          {notFound ? "This session is not available." : error || "The API request failed."}
        </AlertDescription>
      </Alert>
    );
  }

  const hasReplay = manifest.segments.length > 0 || mode === "live";

  return (
    <div className="flex flex-col gap-3">
      <StageHeader
        hasNext={hasNext}
        hasPrev={hasPrev}
        isDemo={isDemo}
        manifest={manifest}
        onStep={onStep}
        projectId={projectId}
        sessionId={sessionId}
      />
      {hasReplay ? (
        <ReplayWorkspace
          isDemo={isDemo}
          manifest={manifest}
          mode={mode}
          projectId={projectId}
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
        </Empty>
      )}
    </div>
  );
}

function StageHeader({
  hasNext,
  hasPrev,
  isDemo,
  manifest,
  onStep,
  projectId,
  sessionId,
}: {
  hasNext: boolean;
  hasPrev: boolean;
  isDemo: boolean;
  manifest: SessionManifest;
  onStep: (delta: 1 | -1) => void;
  projectId: string;
  sessionId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <span className="truncate text-[13px] font-medium text-foreground">
          {entryPath(manifest.attrs.entryUrl ?? null)}
        </span>
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">
          {formatDuration(manifest.durationMs)}
        </span>
        <span
          className="hidden shrink-0 font-mono text-[11px] text-dim lg:inline"
          title={sessionId}
        >
          {sessionId.slice(0, 8)}…
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip content="Previous session (↑ or k in the list)">
          <Button
            aria-label="Previous session"
            className="text-muted-foreground hover:text-foreground"
            disabled={!hasPrev}
            onClick={() => onStep(-1)}
            size="icon-sm"
            variant="ghost"
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
            variant="ghost"
          >
            <ChevronRight aria-hidden className="size-4" />
          </Button>
        </Tooltip>
        <Button asChild size="sm" variant="ghost">
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
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
