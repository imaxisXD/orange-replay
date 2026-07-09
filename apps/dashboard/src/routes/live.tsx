import { type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CountryFlag } from "@/components/country-flag";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, fetchLiveSessions, type LiveSessionItem } from "@/lib/api";
import { AlertCircle, RotateCcw } from "@/lib/icon-map";
import {
  formatLiveSessionRow,
  livePollIntervalMs,
  shouldPollLiveSessions,
  type LiveSessionRow,
} from "@/lib/live-sessions";
import { defaultProjectId } from "@/lib/routes";
import { cn } from "@/lib/utils";

export function LivePage() {
  const params = useParams({ strict: false });
  const projectId = params.projectId ?? defaultProjectId;
  const liveQuery = useQuery({
    queryKey: ["live-sessions", projectId],
    queryFn: ({ signal }) => fetchLiveSessions(projectId, { signal }),
    refetchInterval: () =>
      shouldPollLiveSessions(document.visibilityState) ? livePollIntervalMs : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const sessions: LiveSessionItem[] = liveQuery.data?.sessions ?? [];
  const loading = liveQuery.isPending;
  const error = liveQuery.error === null ? "" : readErrorMessage(liveQuery.error);
  const rows = sessions.map(formatLiveSessionRow);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Live
          <span className="ml-2.5 text-[12px] font-normal text-dim">
            Sessions happening right now.
          </span>
        </h1>
      </div>

      <section className="lit rounded-lg px-4.5 py-4">
        <div className="mb-3.5 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold">Live now</h2>
          <span className="text-[11.5px] text-dim">updates every 5s</span>
        </div>

        {error.length > 0 && (
          <Alert className="mb-4" variant="destructive">
            <AlertCircle aria-hidden />
            <AlertTitle>Could not load live sessions</AlertTitle>
            <AlertDescription>
              <p>{error}</p>
              <Button
                className="mt-2 border-danger-border bg-transparent text-danger-foreground hover:text-foreground"
                leadingIcon={RotateCcw}
                onClick={() => void liveQuery.refetch()}
                size="sm"
                variant="secondary"
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {loading ? (
          <LiveLoadingRows />
        ) : rows.length > 0 ? (
          <div>
            {rows.map((row) => (
              <LiveRow key={row.sessionId} projectId={projectId} row={row} />
            ))}
          </div>
        ) : (
          error.length === 0 && <LiveEmptyState />
        )}
      </section>
    </div>
  );
}

function LiveRow({ projectId, row }: { projectId: string; row: LiveSessionRow }) {
  const navigate = useNavigate();

  function openSession(): void {
    void navigate({
      to: "/projects/$projectId/sessions/$sessionId",
      params: { projectId, sessionId: row.sessionId },
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSession();
  }

  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-2.5 border-b border-dashed border-dash py-2.25 outline-none transition-colors last:border-b-0 hover:bg-hover",
        "focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-2px] focus-visible:outline-amber",
      )}
      onClick={openSession}
      onKeyDown={handleKeyDown}
      role="link"
      tabIndex={0}
    >
      <span aria-hidden className="live-pulse size-1.75 flex-none rounded-full bg-success" />
      <div className="min-w-0 max-w-85">
        <div className="truncate text-[12.5px] font-medium">{row.entryPath}</div>
        <div className="mt-0.25 flex items-center gap-1.5 text-[11.5px] text-dim">
          <CountryFlag country={row.countryCode} />
          <span className="truncate">{row.placeText}</span>
        </div>
      </div>
      <span className="ml-auto flex-none font-mono text-[11.5px] tabular-nums text-muted-foreground">
        {row.elapsedTime}
      </span>
    </div>
  );
}

function LiveLoadingRows() {
  return (
    <div>
      {Array.from({ length: 3 }, (_unused, index) => (
        <div
          className="flex items-center gap-2.5 border-b border-dashed border-dash py-2.25 last:border-b-0"
          key={index}
        >
          <Skeleton className="size-1.75 flex-none rounded-full" />
          <div className="min-w-0 max-w-85 flex-1">
            <Skeleton className="h-3.75 w-55 max-w-full" />
            <Skeleton className="mt-1.25 h-3.25 w-40 max-w-full" />
          </div>
          <Skeleton className="ml-auto h-3.5 w-9.5 flex-none" />
        </div>
      ))}
    </div>
  );
}

function LiveEmptyState() {
  return (
    <div className="flex min-h-26 items-center justify-center rounded-lg border border-dashed border-dash px-4 py-8 text-center text-[13px] text-muted-foreground">
      No live sessions. Active visitors appear here within seconds.
    </div>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
