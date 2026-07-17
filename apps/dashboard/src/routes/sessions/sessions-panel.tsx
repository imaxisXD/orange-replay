import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AnalyticsStaleAlert } from "@/components/analytics-stale-alert";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { filterChips, removeFilterKey } from "@/lib/filter-chips";
import { AlertCircle, ArrowLeft } from "@/lib/icon-map";
import { canMergeSessionHeads, type SessionDisplayItem } from "@/lib/session-list";
import { withDefaultDateRange } from "@/lib/session-filters";
import {
  sessionFilterOf,
  type SessionSort,
  type SessionsViewSearch,
} from "@/lib/sessions-view-search";
import { markSessionWatched, unmarkSessionWatched, watchedSessionIds } from "@/lib/watched";
import { entryPath } from "@/lib/entry-path";
import { SessionFilterChips } from "./session-filter-chips";
import { SessionListPane } from "./session-list-pane";
import { EmptySessionStage, SessionStage } from "./session-stage";
import { SessionsToolbar } from "./sessions-toolbar";
import { useSessionsPanelData } from "./use-sessions-panel-data";

export function SessionsPanel({ isDemo, projectId }: { isDemo: boolean; projectId: string }) {
  const view = useSearch({ strict: false }) as SessionsViewSearch;
  const [initialNow] = useState(() => Date.now());
  const searchFilter = sessionFilterOf(view);
  const filter = withDefaultDateRange(searchFilter, initialNow);
  const sort: SessionSort = view.sort ?? "newest";
  const selected = view.selected;
  const includeSessionHeads = !isDemo && canMergeSessionHeads(searchFilter, sort);
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

  const data = useSessionsPanelData({
    filter,
    includeSessionHeads,
    initialNow,
    isDemo,
    projectId,
    searchFilter,
    sort,
  });
  const sessions = data.sessions;
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
  const selectedSessionId =
    selected !== undefined && (!isDemo || selectedIndex !== -1) ? selected : undefined;
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
  return (
    <div className="flex flex-col gap-3">
      <SessionsToolbar
        countries={data.countries}
        countryQueryFailed={data.countryQueryFailed}
        countryQueryPending={data.countryQueryPending}
        filter={filter}
        hasMore={data.hasMore}
        isLoading={data.loadState === "loading"}
        isRefreshing={data.isRefreshing}
        onFilterChange={replaceFilter}
        onRefresh={data.refresh}
        sessionCount={sessions.length}
      />

      <SessionFilterChips
        chips={chips}
        onClear={() => replaceFilter({})}
        onRemove={(key) => replaceFilter(removeFilterKey(filter, key))}
      />

      {data.analyticsAreStale && <AnalyticsStaleAlert />}

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

      {data.error.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load sessions</AlertTitle>
          <AlertDescription>
            <p>{data.error}</p>
            <Button onClick={data.retry} size="sm" variant="secondary">
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex min-w-0 items-start gap-5">
        <SessionListPane
          className={selectedSessionId === undefined ? "flex" : "hidden lg:flex"}
          chipsCount={chips.length}
          error={data.error}
          hasMore={data.hasMore}
          loadState={data.loadState}
          onClearFilters={() => replaceFilter({})}
          onLoadMore={data.loadMore}
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
          selected={selectedSessionId}
          sessions={sessions}
          sort={sort}
          unwatchedOnly={unwatchedOnly}
          visibleSessions={visibleSessions}
          watched={watched}
        />

        <div
          className={
            selectedSessionId === undefined ? "hidden min-w-0 flex-1 lg:block" : "min-w-0 flex-1"
          }
        >
          {selectedSessionId !== undefined && (
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
          {selectedSessionId === undefined ? (
            <EmptySessionStage
              reason={
                data.loadState !== "loading" && sessions.length === 0
                  ? "no_sessions"
                  : "no_selection"
              }
            />
          ) : (
            <SessionStage
              mode={isDemo ? "demo" : "project"}
              navigation={{
                back: () => replaceView({ ...view, selected: undefined }),
                ...(selectedIndex !== -1 && selectedIndex < visibleSessions.length - 1
                  ? { next: () => stepSelection(1) }
                  : {}),
                ...(selectedIndex > 0 ? { previous: () => stepSelection(-1) } : {}),
              }}
              onPlaybackStarted={() => markPlaybackStarted(selectedSessionId)}
              {...(watched.has(selectedSessionId)
                ? { onMarkUnwatched: () => markUnwatched(selectedSessionId) }
                : {})}
              projectId={projectId}
              sessionId={selectedSessionId}
            />
          )}
        </div>
      </div>

      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
    </div>
  );
}
