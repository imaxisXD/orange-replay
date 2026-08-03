import { useEffect, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import liveSignalWatchSrc from "@/assets/empty-states/signal-watch-winged-receiver.webp";
import liveBrowserBeetleSrc from "@/assets/empty-states/layers/live-browser-beetle.webp";
import liveCursorBeeSrc from "@/assets/empty-states/layers/live-cursor-bee.webp";
import liveReceiverMothSrc from "@/assets/empty-states/layers/live-receiver-moth.webp";
import liveSignalBirdSrc from "@/assets/empty-states/layers/live-signal-bird.webp";
import liveTabPigeonSrc from "@/assets/empty-states/layers/live-tab-pigeon.webp";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CountryFlag } from "@/components/country-flag";
import { LiveBadge, LiveDot } from "@/components/live-badge";
import {
  ParallaxEmptyStateField,
  type ParallaxEmptyStateLayer,
} from "@/components/parallax-empty-state-field";
import {
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { LoadingArea } from "@/components/ui/loading-indicator";
import {
  accountQueryKey,
  ApiError,
  fetchAccount,
  fetchInstallStatus,
  fetchLiveSessions,
  liveSessionsQueryKey,
  type LiveSessionItem,
} from "@/lib/api";
import { canManageProject, findAccountProject, readDashboardAccess } from "@/lib/dashboard-access";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { AlertCircle, RotateCcw } from "@/lib/icon-map";
import {
  formatLiveSessionRow,
  isLiveHandoffConnecting,
  liveHandoffQueryKey,
  livePollIntervalMs,
  shouldPollLiveSessions,
  type LiveHandoffState,
  type LiveSessionRow,
} from "@/lib/live-sessions";
import { carriedDateRangeSearch } from "@/lib/session-filters";
import { cn } from "@/lib/utils";

export function LivePage() {
  const { projectId, isDemo } = useDashboardWorkspace();
  const queryClient = useQueryClient();
  const handoff = isDemo
    ? undefined
    : queryClient.getQueryData<LiveHandoffState>(liveHandoffQueryKey(projectId));
  const [handoffClock, setHandoffClock] = useState(() => Date.now());
  const connectingFromOnboarding = isLiveHandoffConnecting(handoff, handoffClock);
  useEffect(() => {
    if (!connectingFromOnboarding || handoff === undefined) return;
    const timeout = window.setTimeout(
      () => setHandoffClock(Date.now()),
      Math.max(0, handoff.connectingUntil - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [connectingFromOnboarding, handoff]);
  const liveQuery = useQuery({
    queryKey: liveSessionsQueryKey(projectId, isDemo),
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
        {rows.length > 0 && (
          <div className="mb-3.5 flex items-baseline justify-between">
            <h2>
              <LiveBadge />
            </h2>
            <span className="text-[11.5px] text-muted-foreground">
              {truncated ? "showing newest 100 · " : ""}updates every 5s
            </span>
          </div>
        )}

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

        {loading && !connectingFromOnboarding ? (
          <LiveLoadingRows />
        ) : rows.length > 0 ? (
          <div>
            {rows.map((row) => (
              <LiveRow isDemo={isDemo} key={row.sessionId} projectId={projectId} row={row} />
            ))}
          </div>
        ) : (
          error.length === 0 && (
            <LiveEmptyState
              isConnecting={connectingFromOnboarding}
              isDemo={isDemo}
              projectId={projectId}
            />
          )
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

function LiveEmptyState({
  isConnecting,
  isDemo,
  projectId,
}: {
  isConnecting: boolean;
  isDemo: boolean;
  projectId: string;
}) {
  const access = readDashboardAccess(isDemo ? "demo" : "private");
  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: fetchAccount,
    enabled: access.needsAccount && !isConnecting,
    staleTime: 30_000,
  });
  // Only owners and admins can reach the install page, and only they may read
  // install status. Everyone else gets the recorded-sessions exit.
  const canInstall = !isDemo && canManageProject(findAccountProject(accountQuery.data, projectId));
  const installStatusQuery = useQuery({
    queryKey: ["install-status", projectId],
    queryFn: () => fetchInstallStatus(projectId),
    enabled: canInstall && !isConnecting,
    staleTime: 30_000,
  });
  // "Install the snippet" is only honest once the API confirms no event has ever
  // arrived. While the check is pending or failed, keep the neutral copy.
  const awaitingFirstEvent = canInstall && installStatusQuery.data?.firstEventAt === null;

  return (
    <div className="min-h-26 overflow-hidden">
      <ParallaxEmptyStateField
        className="min-h-[34rem] w-full px-4 py-8 sm:min-h-[38rem]"
        layers={LIVE_EMPTY_STATE_LAYERS}
      >
        <EmptyHeader className="max-w-md gap-2">
          <EmptyMedia
            aria-hidden="true"
            className="relative mb-4 h-72 w-72 select-none sm:h-80 sm:w-96"
          >
            <div className="signal-watch__art">
              <img alt="" draggable={false} src={liveSignalWatchSrc} />
              <div className="signal-watch__overlay">
                <span className="signal-watch__ring signal-watch__ring--inner" />
                <span className="signal-watch__ring signal-watch__ring--middle" />
                <span className="signal-watch__ring signal-watch__ring--outer" />
                <span className="signal-watch__beacon" />
              </div>
            </div>
          </EmptyMedia>
          <EmptyTitle aria-live={isConnecting ? "polite" : undefined}>
            {isConnecting
              ? "Connecting to your live session…"
              : awaitingFirstEvent
                ? "No events from your site yet"
                : "No one is browsing right now"}
          </EmptyTitle>
          <EmptyDescription>
            {isConnecting
              ? "Orange Replay received your first event. This page will update as soon as the session appears."
              : awaitingFirstEvent
                ? "Add the snippet to your site and visitors show up here within seconds of landing."
                : "Visitors show up here within seconds of landing. This list refreshes every 5 seconds, so you can leave it open."}
          </EmptyDescription>
        </EmptyHeader>
        {!isConnecting && (
          <EmptyContent>
            {/* Installing is the only thing that fills this page, so it carries the
              primary plate. Browsing recordings is a sideways move: secondary. */}
            <Button asChild size="sm" variant={awaitingFirstEvent ? "primary" : "secondary"}>
              {awaitingFirstEvent ? (
                <Link params={{ projectId }} to="/projects/$projectId/install">
                  Install the snippet
                </Link>
              ) : isDemo ? (
                <Link search={carriedDateRangeSearch} to="/demo/sessions">
                  Browse recorded sessions
                </Link>
              ) : (
                <Link
                  params={{ projectId }}
                  search={carriedDateRangeSearch}
                  to="/projects/$projectId/sessions"
                >
                  Browse recorded sessions
                </Link>
              )}
            </Button>
          </EmptyContent>
        )}
      </ParallaxEmptyStateField>
    </div>
  );
}

const LIVE_EMPTY_STATE_LAYERS: readonly ParallaxEmptyStateLayer[] = [
  {
    src: liveBrowserBeetleSrc,
    left: "11%",
    top: "58%",
    width: "clamp(4rem, 7vw, 7rem)",
    movement: 13,
    opacity: 0.42,
    rotation: -7,
  },
  {
    src: liveSignalBirdSrc,
    left: "91%",
    top: "52%",
    width: "clamp(3.6rem, 5.8vw, 5.8rem)",
    movement: -12,
    opacity: 0.38,
    rotation: 6,
  },
  {
    src: liveCursorBeeSrc,
    left: "18%",
    top: "27%",
    width: "clamp(3rem, 4.8vw, 4.8rem)",
    movement: -17,
    opacity: 0.34,
    rotation: -9,
  },
  {
    src: liveReceiverMothSrc,
    left: "82%",
    top: "23%",
    width: "clamp(3.2rem, 5vw, 5rem)",
    movement: 17,
    opacity: 0.3,
    rotation: 8,
  },
  {
    src: liveTabPigeonSrc,
    left: "91%",
    top: "79%",
    width: "clamp(3.6rem, 5.6vw, 5.6rem)",
    movement: 14,
    opacity: 0.32,
    rotation: 4,
  },
  {
    src: liveCursorBeeSrc,
    left: "4%",
    top: "87%",
    width: "clamp(2rem, 3vw, 3rem)",
    movement: 21,
    opacity: 0.2,
    rotation: 14,
  },
  {
    src: liveSignalBirdSrc,
    left: "70%",
    top: "84%",
    width: "clamp(2.1rem, 3.1vw, 3.1rem)",
    movement: -18,
    opacity: 0.2,
    rotation: -8,
  },
  {
    src: liveReceiverMothSrc,
    left: "7%",
    top: "17%",
    width: "clamp(2rem, 2.8vw, 2.8rem)",
    movement: -20,
    opacity: 0.18,
    rotation: 11,
  },
];

function readErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Could not load live sessions. Try again.";
  if (error.code === "network_error") return error.message;
  if (error.status === 429) return "Too many requests. Wait a moment and try again.";
  if (error.code === "invalid_response") {
    return "Live sessions returned unexpected data. Refresh the page and try again.";
  }
  if (error.status >= 500) return "Live sessions are temporarily unavailable. Try again.";
  return "Could not load live sessions. Try again.";
}
