import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiError, fetchProjectStats, listSessions, type SessionListItem } from "@/lib/api";
import { filterChips, removeFilterKey } from "@/lib/filter-chips";
import { AlertCircle, ArrowLeft } from "@/lib/icon-map";
import { appendUniqueSessions, canLoadMore } from "@/lib/session-list";
import { canonicalSessionFilter } from "@/lib/session-filters";
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
  const filter = sessionFilterOf(view);
  const sort: SessionSort = view.sort ?? "newest";
  const selected = view.selected;
  const navigate = useNavigate();
  const [, setWatchedVersion] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [recentlyWatched, setRecentlyWatched] = useState<{
    sessionId: string;
    label: string;
  } | null>(null);
  const watched = watchedSessionIds(projectId);

  const chips = filterChips(filter);

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
    navigateView({ ...nextFilter, selected, sort: view.sort });
  }

  function selectSession(session: SessionListItem): void {
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
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      listSessions(
        projectId,
        {
          ...filter,
          sort,
          before: pageParam,
          limit: pageSize,
        },
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.nextBefore,
  });

  const countriesQuery = useQuery({
    queryKey: ["stats-countries", isDemo ? "demo" : "private", projectId],
    queryFn: ({ signal }) => fetchProjectStats(projectId, {}, { signal }),
    staleTime: 60_000,
  });
  const countries = countriesQuery.data?.breakdowns.country ?? [];

  const sessions = (sessionsQuery.data?.pages ?? []).reduce<SessionListItem[]>(
    (currentSessions, page) => appendUniqueSessions(currentSessions, page.sessions),
    [],
  );
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
  const loadState = sessionsQuery.isPending
    ? "loading"
    : sessionsQuery.isFetchingNextPage
      ? "loading_more"
      : "idle";
  const error = sessionsQuery.error === null ? "" : readErrorMessage(sessionsQuery.error);

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
          sessionsQuery.isFetching && !sessionsQuery.isPending && !sessionsQuery.isFetchingNextPage
        }
        onFilterChange={replaceFilter}
        onRefresh={() => void sessionsQuery.refetch()}
        sessionCount={sessions.length}
      />

      <SessionFilterChips
        chips={chips}
        onClear={() => replaceFilter({})}
        onRemove={(key) => replaceFilter(removeFilterKey(filter, key))}
      />

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
