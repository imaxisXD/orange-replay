import { type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CountryFlag } from "@/components/country-flag";
import { LiveBadge, LiveDot } from "@/components/live-badge";
import { LoadingArea } from "@/components/ui/loading-indicator";
import { ApiError, fetchLiveSessions, type LiveSessionItem } from "@/lib/api";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { AlertCircle, RotateCcw } from "@/lib/icon-map";
import {
  formatLiveSessionRow,
  livePollIntervalMs,
  shouldPollLiveSessions,
  type LiveSessionRow,
} from "@/lib/live-sessions";
import { cn } from "@/lib/utils";

export function LivePage() {
  const { projectId, isDemo } = useDashboardWorkspace();
  const liveQuery = useQuery({
    queryKey: ["live-sessions", isDemo ? "demo" : "private", projectId],
    queryFn: ({ signal }) => fetchLiveSessions(projectId, { signal }),
    refetchInterval: () =>
      shouldPollLiveSessions(document.visibilityState) ? livePollIntervalMs : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const sessions: LiveSessionItem[] = liveQuery.data?.sessions ?? [];
  const truncated = liveQuery.data?.truncated === true;
  const loading = liveQuery.isPending;
  const error = liveQuery.error === null ? "" : readErrorMessage(liveQuery.error);
  const rows = sessions.map(formatLiveSessionRow);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex max-w-2xl flex-col gap-1">
        <h1 className="text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]">Live</h1>
        <p className="text-[12px] leading-normal text-muted-foreground">
          Sessions happening right now.
        </p>
      </header>

      <section className="lit rounded-lg px-4.5 py-4">
        <div className="mb-3.5 flex items-baseline justify-between">
          <h2>
            <LiveBadge />
          </h2>
          <span className="text-[11.5px] text-muted-foreground">
            {truncated ? "showing newest 100 · " : ""}updates every 5s
          </span>
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
              <LiveRow isDemo={isDemo} key={row.sessionId} projectId={projectId} row={row} />
            ))}
          </div>
        ) : (
          error.length === 0 && <LiveEmptyState />
        )}
      </section>
    </div>
  );
}

function LiveRow({
  isDemo,
  projectId,
  row,
}: {
  isDemo: boolean;
  projectId: string;
  row: LiveSessionRow;
}) {
  const navigate = useNavigate();

  function openSession(): void {
    if (isDemo) {
      void navigate({
        to: "/demo/sessions/$sessionId",
        params: { sessionId: row.sessionId },
      });
      return;
    }

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
      <LiveDot size="sm" />
      <div className="min-w-0 max-w-85">
        <div className="truncate text-[12.5px] font-medium" title={row.entryPath}>
          {row.entryPath}
        </div>
        <div className="mt-0.25 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <CountryFlag country={row.countryCode} />
          <span className="truncate" title={row.placeText}>
            {row.placeText}
          </span>
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
    <LoadingArea
      className="min-h-26 rounded-lg border border-dashed border-dash"
      label="Loading live sessions"
    />
  );
}

function LiveEmptyState() {
  return (
    <div className="flex min-h-26 items-center justify-center rounded-lg border border-dashed border-dash px-4 py-8 text-center text-[13px] text-muted-foreground">
      No one is browsing right now. Visitors appear here within seconds of landing.
    </div>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The request failed. Try again in a moment.";
}
