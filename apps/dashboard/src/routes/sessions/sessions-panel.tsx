import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AnalyticsStaleAlert } from "@/components/analytics-stale-alert";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ApiError,
  fetchProjectStats,
  fetchSessionHeads,
  listSessions,
  type SessionListItem,
} from "@/lib/api";
import { filterChips, removeFilterKey } from "@/lib/filter-chips";
import { AlertCircle, ArrowLeft } from "@/lib/icon-map";
import { livePollIntervalMs, shouldPollLiveSessions } from "@/lib/live-sessions";
import {
  appendUniqueSessions,
  canMergeSessionHeads,
  canLoadMore,
  hasStaleAnalytics,
  mergeSessionRows,
  nextTrackedSessionHeadIds,
  sessionHeadsFilter,
  type SessionDisplayItem,
  nextSessionPageParam,
  type SessionPageParam,
} from "@/lib/session-list";
import {
  canonicalSessionFilter,
  dateRangeSnapshotFilter,
  withDefaultDateRange,
} from "@/lib/session-filters";
import {
  sessionFilterOf,
  type SessionSort,
  type SessionsViewSearch,
} from "@/lib/sessions-view-search";
import { markSessionWatched, unmarkSessionWatched, watchedSessionIds } from "@/lib/watched";
import { entryPath } from "./session-card";
import { SessionFilterChips } from "./session-filter-chips";
import { SessionListPane } from "./session-list-pane";
import { SessionStage } from "./session-stage";
import { SessionsToolbar } from "./sessions-toolbar";

const pageSize = 25;

export function SessionsPanel({ isDemo, projectId }: { isDemo: boolean; projectId: string }) {
  const view = useSearch({ strict: false }) as SessionsViewSearch;
  const [initialNow] = useState(() => Date.now());
  const searchFilter = sessionFilterOf(view);
  const filter = withDefaultDateRange(searchFilter, initialNow);
  const countryStatsFilter = dateRangeSnapshotFilter(filter);
  const sort: SessionSort = view.sort ?? "newest";
  const selected = view.selected;
  const includeSessionHeads = canMergeSessionHeads(searchFilter, sort);
  const navigate = useNavigate();
  const [, setWatchedVersion] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [recentlyWatched, setRecentlyWatched] = useState<{
    sessionId: string;
    label: string;
  } | null>(null);
  const watched = watchedSessionIds(projectId);

  const chips = filterChips(searchFilter);

  function navigateView(nextView: SessionsViewSearch, options: { push?: boolean } = {}): void {
    const replace = options.push !== true;
    if (isDemo) {
      void navigate({ to: "/demo/sessions", search: nextView, replace });
      return;
    }
    void navigate({
      to: "/projects/$projectId/sessions",
      params: { projectId },
      search: nextView,
      replace,
    });
  }

  function replaceView(nextView: SessionsViewSearch): void {
    navigateView(nextView);
  }

  function replaceFilter(nextFilter: SessionsViewSearch): void {
    const nextSearchFilter = { ...nextFilter };
    if (
      searchFilter.from === undefined &&
      searchFilter.to === undefined &&
      nextSearchFilter.from === filter.from &&
      nextSearchFilter.to === filter.to
    ) {
      nextSearchFilter.from = undefined;
      nextSearchFilter.to = undefined;
    }
    navigateView({ ...nextSearchFilter, selected, sort: view.sort });
  }

  function selectSession(session: SessionDisplayItem): void {
    setAnnouncement(`Selected ${entryPath(session.entry_url)}`);
    // Selection is the high-frequency, high-regret action — it pushes history
    // so Back walks the triage trail; keystroke-level filter edits replace.
    navigateView({ ...view, selected: session.session_id }, { push: true });
    // Router re-render drops focus to <body>; put it back on the card so
    // arrow keys / j / k keep working after every selection.
    requestAnimationFrame(() => {
      railRef.current
        ?.querySelector<HTMLElement>(`[data-session-id="${session.session_id}"]`)
        ?.focus();
    });
  }

  const sessionsQuery = useInfiniteQuery({
    queryKey: [
      "sessions",
      isDemo ? "demo" : "private",
      projectId,
      canonicalSessionFilter(filter),
      sort,
    ],
    initialPageParam: { before: null } satisfies SessionPageParam,
    queryFn: ({ pageParam, signal }) =>
      listSessions(
        projectId,
        {
          ...filter,
          sort,
          before: pageParam.before,
          limit: pageSize,
          warehouse_version: pageParam.warehouseVersion ?? filter.warehouse_version,
        },
        { signal },
      ),
    getNextPageParam: nextSessionPageParam,
  });

  const countriesQuery = useQuery({
    queryKey: [
      "stats-countries",
      isDemo ? "demo" : "private",
      projectId,
      canonicalSessionFilter(countryStatsFilter),
    ],
    queryFn: ({ signal }) => fetchProjectStats(projectId, countryStatsFilter, { signal }),
    staleTime: 60_000,
  });
  const countries = countriesQuery.data?.breakdowns.country ?? [];

  const sessionPages = sessionsQuery.data?.pages ?? [];
  const warehouseSessions = sessionPages.reduce<SessionListItem[]>(
    (currentSessions, page) => appendUniqueSessions(currentSessions, page.sessions),
    [],
  );
  const warehouseVersion = sessionPages[0]?.warehouseVersion ?? filter.warehouse_version;
  const headsFilter = sessionHeadsFilter(filter, searchFilter, warehouseVersion);
  const usesRollingDefault = searchFilter.from === undefined && searchFilter.to === undefined;
  const headTrackingScope = `${projectId}\n${canonicalSessionFilter(searchFilter)}\n${sort}`;
  const trackedSessionHeads = useRef({ scope: headTrackingScope, sessionIds: [] as string[] });
  const headsQuery = useQuery({
    enabled: includeSessionHeads,
    queryKey: [
      "session-heads",
      isDemo ? "demo" : "private",
      projectId,
      canonicalSessionFilter(filter),
      usesRollingDefault,
      initialNow,
      sort,
    ],
    queryFn: async ({ signal }) => {
      const previousTracking =
        trackedSessionHeads.current.scope === headTrackingScope
          ? trackedSessionHeads.current
          : { scope: headTrackingScope, sessionIds: [] };
      trackedSessionHeads.current = previousTracking;
      const response = await fetchSessionHeads(
        projectId,
        {
          ...headsFilter,
          limit: 100,
          sort,
          opened_at: initialNow,
          ...(usesRollingDefault && filter.to !== undefined ? { warehouse_to: filter.to } : {}),
          tracked_session_id: previousTracking.sessionIds,
        },
        { signal },
      );
      trackedSessionHeads.current = {
        scope: headTrackingScope,
        sessionIds: nextTrackedSessionHeadIds(
          previousTracking.sessionIds,
          response.sessions,
          warehouseSessions,
        ),
      };
      return response;
    },
    refetchInterval: () =>
      shouldPollLiveSessions(document.visibilityState) ? livePollIntervalMs : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const heads = includeSessionHeads ? (headsQuery.data?.sessions ?? []) : [];
  const sessions = mergeSessionRows(warehouseSessions, heads, sort);
  const refetchHeads = headsQuery.refetch;
  const lastRequestedWarehouseVersion = useRef<{
    scope: string;
    warehouseVersion: number;
  } | null>(null);
  const lastWarehouseRefresh = useRef({ scope: headTrackingScope, updatedAt: 0 });
  const refetchSessions = sessionsQuery.refetch;

  useEffect(() => {
    if (!includeSessionHeads) {
      trackedSessionHeads.current = { scope: headTrackingScope, sessionIds: [] };
    }
  }, [headTrackingScope, includeSessionHeads]);

  // Keep the visible heads while the exact warehouse watermark changes, then
  // ask the same query for the new bridge set.
  useEffect(() => {
    if (
      !includeSessionHeads ||
      warehouseVersion === undefined ||
      (lastRequestedWarehouseVersion.current?.scope === headTrackingScope &&
        lastRequestedWarehouseVersion.current.warehouseVersion === warehouseVersion)
    ) {
      return;
    }
    lastRequestedWarehouseVersion.current = { scope: headTrackingScope, warehouseVersion };
    void refetchHeads();
  }, [headTrackingScope, includeSessionHeads, refetchHeads, warehouseVersion]);

  // Once D1 has exact details, check R2 after each head poll. The exact page
  // keeps its own cursor; this only lets it replace the bridge row when ready.
  useEffect(() => {
    const updatedAt = headsQuery.dataUpdatedAt;
    const previousUpdatedAt =
      lastWarehouseRefresh.current.scope === headTrackingScope
        ? lastWarehouseRefresh.current.updatedAt
        : 0;
    if (updatedAt === 0 || updatedAt <= previousUpdatedAt) return;
    lastWarehouseRefresh.current = { scope: headTrackingScope, updatedAt };
    if (
      document.visibilityState === "hidden" ||
      !heads.some((session) => session.details_state === "exact")
    ) {
      return;
    }
    void refetchSessions();
  }, [headTrackingScope, heads, headsQuery.dataUpdatedAt, refetchSessions]);
  const analyticsAreStale =
    hasStaleAnalytics(sessionPages) || countriesQuery.data?.analyticsState === "stale";
  // Unwatched-only is a client-side lens (watched state lives in localStorage);
  // the selected session always stays visible so it does not vanish when
  // playback starts and marks it watched.
  const unwatchedOnly = view.unwatched === true;
  const visibleSessions = unwatchedOnly
    ? sessions.filter(
        (session) => !watched.has(session.session_id) || session.session_id === selected,
      )
    : sessions;
  const selectedIndex = visibleSessions.findIndex((session) => session.session_id === selected);
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (recentlyWatched === null) return;
    const timeout = window.setTimeout(() => setRecentlyWatched(null), 6_000);
    return () => window.clearTimeout(timeout);
  }, [recentlyWatched]);

  function markPlaybackStarted(sessionId: string): void {
    if (watchedSessionIds(projectId).has(sessionId)) return;
    markSessionWatched(projectId, sessionId);
    setWatchedVersion((version) => version + 1);
    const session = sessions.find((item) => item.session_id === sessionId);
    setRecentlyWatched({
      sessionId,
      label: entryPath(session?.entry_url ?? null),
    });
  }

  function markUnwatched(sessionId: string): void {
    unmarkSessionWatched(projectId, sessionId);
    setWatchedVersion((version) => version + 1);
    setRecentlyWatched(null);
    setAnnouncement("Session marked unwatched");
  }

  function stepSelection(delta: 1 | -1): void {
    if (visibleSessions.length === 0) return;
    const targetIndex =
      selectedIndex === -1
        ? delta > 0
          ? 0
          : visibleSessions.length - 1
        : Math.min(Math.max(selectedIndex + delta, 0), visibleSessions.length - 1);
    const target = visibleSessions[targetIndex];
    if (target === undefined || target.session_id === selected) return;
    selectSession(target);
  }

  function handleRailKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      stepSelection(1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      stepSelection(-1);
    }
  }
  const nextBefore = sessionsQuery.data?.pages.at(-1)?.nextBefore ?? null;
  const waitingForFirstRows =
    sessions.length === 0 &&
    (sessionsQuery.isPending || (includeSessionHeads && headsQuery.isPending));
  const loadState = waitingForFirstRows
    ? "loading"
    : sessionsQuery.isFetchingNextPage
      ? "loading_more"
      : "idle";
  const sessionsError = sessionsQuery.error === null ? "" : readErrorMessage(sessionsQuery.error);
  const headsError = headsQuery.error === null ? "" : readErrorMessage(headsQuery.error);
  const error =
    sessionsError || (warehouseSessions.length === 0 && heads.length === 0 ? headsError : "");

  async function loadMore(): Promise<void> {
    if (!canLoadMore(nextBefore) || loadState !== "idle") return;
    await sessionsQuery.fetchNextPage();
  }

  return (
    <div className="flex flex-col gap-3">
      <SessionsToolbar
        countries={countries}
        countryQueryFailed={countriesQuery.isError}
        countryQueryPending={countriesQuery.isPending}
        filter={filter}
        hasMore={canLoadMore(nextBefore)}
        isLoading={loadState === "loading"}
        isRefreshing={
          (sessionsQuery.isFetching &&
            !sessionsQuery.isPending &&
            !sessionsQuery.isFetchingNextPage) ||
          headsQuery.isFetching
        }
        onFilterChange={replaceFilter}
        onRefresh={() => {
          void sessionsQuery.refetch();
          if (includeSessionHeads) void headsQuery.refetch();
        }}
        sessionCount={sessions.length}
      />

      <SessionFilterChips
        chips={chips}
        onClear={() => replaceFilter({})}
        onRemove={(key) => replaceFilter(removeFilterKey(filter, key))}
      />

      {analyticsAreStale && <AnalyticsStaleAlert />}

      {recentlyWatched !== null && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-[12.5px] text-muted-foreground"
          role="status"
        >
          <span className="truncate">
            Marked <span className="font-medium text-foreground">{recentlyWatched.label}</span> as
            watched after playback started.
          </span>
          <Button
            className="h-auto shrink-0 px-0 py-0 text-[12.5px]"
            onClick={() => markUnwatched(recentlyWatched.sessionId)}
            variant="ghost"
          >
            Undo
          </Button>
        </div>
      )}

      {error.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load sessions</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button onClick={() => void sessionsQuery.refetch()} size="sm" variant="secondary">
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex min-w-0 items-start gap-5">
        <SessionListPane
          className={selected === undefined ? "flex" : "hidden lg:flex"}
          chipsCount={chips.length}
          error={error}
          hasMore={canLoadMore(nextBefore)}
          loadState={loadState}
          onClearFilters={() => replaceFilter({})}
          onLoadMore={loadMore}
          onRailKeyDown={handleRailKeyDown}
          onSelect={selectSession}
          onShowAll={() => replaceView({ ...view, unwatched: undefined })}
          onSortChange={(value) =>
            replaceView({
              ...view,
              sort: value === "newest" ? undefined : value,
            })
          }
          onToggleUnwatched={() =>
            replaceView({ ...view, unwatched: unwatchedOnly ? undefined : true })
          }
          railRef={railRef}
          selected={selected}
          sessions={sessions}
          sort={sort}
          unwatchedOnly={unwatchedOnly}
          visibleSessions={visibleSessions}
          watched={watched}
        />

        <div
          className={selected === undefined ? "hidden min-w-0 flex-1 lg:block" : "min-w-0 flex-1"}
        >
          {selected !== undefined && (
            <Button
              className="mb-3 lg:hidden"
              leadingIcon={ArrowLeft}
              onClick={() => replaceView({ ...view, selected: undefined })}
              size="sm"
              variant="secondary"
            >
              Back to sessions
            </Button>
          )}
          <SessionStage
            hasNext={selectedIndex !== -1 && selectedIndex < visibleSessions.length - 1}
            hasPrev={selectedIndex > 0}
            isDemo={isDemo}
            isWatched={selected === undefined ? false : watched.has(selected)}
            onBack={() => replaceView({ ...view, selected: undefined })}
            onMarkUnwatched={() => {
              if (selected !== undefined) markUnwatched(selected);
            }}
            onPlaybackStarted={() => {
              if (selected !== undefined) markPlaybackStarted(selected);
            }}
            onStep={stepSelection}
            projectId={projectId}
            railEmpty={loadState !== "loading" && sessions.length === 0}
            sessionId={selected}
          />
        </div>
      </div>

      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
    </div>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return readableApiError(error);
  if (error instanceof Error) return error.message;
  return "The request failed. Try again in a moment.";
}

function readableApiError(error: ApiError): string {
  if (error.code === "network_error") return error.message;
  if (error.status >= 500) return "The sessions service is unavailable. Try again in a moment.";
  return error.message.replaceAll("_", " ");
}
