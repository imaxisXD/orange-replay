import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, fetchLiveSessions, type LiveSessionItem } from "@/lib/api";
import {
  formatLiveSessionRow,
  livePollIntervalMs,
  shouldPollLiveSessions,
  type LiveSessionRow,
} from "@/lib/live-sessions";
import { cn } from "@/lib/utils";
import { defaultProjectId } from "@/router";

export function LivePage() {
  const params = useParams();
  const projectId = params.projectId ?? defaultProjectId;
  const [sessions, setSessions] = useState<LiveSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadLiveSessions = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true);
      setError("");

      try {
        const response = await fetchLiveSessions(projectId);
        setSessions(response.sessions);
      } catch (caughtError) {
        setSessions([]);
        setError(readErrorMessage(caughtError));
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    let intervalId: number | undefined;

    function stopPolling(): void {
      if (intervalId === undefined) return;
      window.clearInterval(intervalId);
      intervalId = undefined;
    }

    function startPolling(): void {
      stopPolling();
      if (!shouldPollLiveSessions(document.visibilityState)) return;

      intervalId = window.setInterval(() => {
        if (shouldPollLiveSessions(document.visibilityState)) {
          void loadLiveSessions();
        }
      }, livePollIntervalMs);
    }

    function handleVisibilityChange(): void {
      if (!shouldPollLiveSessions(document.visibilityState)) {
        stopPolling();
        return;
      }

      void loadLiveSessions();
      startPolling();
    }

    void loadLiveSessions(true);
    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadLiveSessions]);

  const rows = sessions.map(formatLiveSessionRow);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Live
          <span className="ml-[10px] text-[12px] font-normal text-dim">
            Sessions happening right now.
          </span>
        </h1>
      </div>

      <section className="lit rounded-lg px-[18px] py-4">
        <div className="mb-[14px] flex items-baseline justify-between">
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
                className="mt-2 border-[rgba(244,83,78,0.35)] bg-transparent text-[#ffb3b0] hover:text-foreground"
                leadingIcon={RotateCcw}
                onClick={() => void loadLiveSessions(true)}
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
  const href = `/projects/${projectId}/sessions/${row.sessionId}`;

  function openSession(): void {
    void navigate(href);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSession();
  }

  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-[10px] border-b border-dashed border-dash py-[9px] outline-none transition-colors last:border-b-0 hover:bg-[#141419]",
        "focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-2px] focus-visible:outline-amber",
      )}
      onClick={openSession}
      onKeyDown={handleKeyDown}
      role="link"
      tabIndex={0}
    >
      <span aria-hidden className="live-pulse size-[7px] flex-none rounded-full bg-success" />
      <div className="min-w-0 max-w-[340px]">
        <div className="truncate text-[12.5px] font-medium">{row.entryPath}</div>
        <div className="mt-[1px] truncate text-[11.5px] text-dim">{row.placeText}</div>
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
          className="flex items-center gap-[10px] border-b border-dashed border-dash py-[9px] last:border-b-0"
          key={index}
        >
          <Skeleton className="size-[7px] flex-none rounded-full" />
          <div className="min-w-0 max-w-[340px] flex-1">
            <Skeleton className="h-[15px] w-[220px] max-w-full" />
            <Skeleton className="mt-[5px] h-[13px] w-[160px] max-w-full" />
          </div>
          <Skeleton className="ml-auto h-[14px] w-[38px] flex-none" />
        </div>
      ))}
    </div>
  );
}

function LiveEmptyState() {
  return (
    <div className="flex min-h-[104px] items-center justify-center rounded-lg border border-dashed border-dash px-4 py-8 text-center text-[13px] text-muted-foreground">
      No live sessions. Active visitors appear here within seconds.
    </div>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
