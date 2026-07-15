import type { SessionFilter } from "@orange-replay/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  ApiError,
  fetchProjectStats,
  fetchSessionHeads,
  listSessions,
  type SessionHead,
  type SessionListItem,
} from "@/lib/api";
import { livePollIntervalMs, shouldPollLiveSessions } from "@/lib/live-sessions";
import {
  appendUniqueSessions,
  canLoadMore,
  hasStaleAnalytics,
  mergeSessionRows,
  nextSessionPageParam,
  nextTrackedSessionHeadIds,
  sessionHeadsFilter,
  type SessionPageParam,
} from "@/lib/session-list";
import { canonicalSessionFilter, dateRangeSnapshotFilter } from "@/lib/session-filters";
import type { SessionSort } from "@/lib/sessions-view-search";
import type { SessionListLoadState } from "./session-list-pane";

const pageSize = 25;
const emptySessionHeads: SessionHead[] = [];

interface SessionsPanelDataOptions {
  filter: SessionFilter;
  includeSessionHeads: boolean;
  initialNow: number;
  isDemo: boolean;
  projectId: string;
  searchFilter: SessionFilter;
  sort: SessionSort;
}

export function useSessionsPanelData({
  filter,
  includeSessionHeads,
  initialNow,
  isDemo,
  projectId,
  searchFilter,
  sort,
}: SessionsPanelDataOptions) {
  const countryStatsFilter = dateRangeSnapshotFilter(filter);
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
  const heads = includeSessionHeads
    ? (headsQuery.data?.sessions ?? emptySessionHeads)
    : emptySessionHeads;
  const sessions = mergeSessionRows(warehouseSessions, heads, sort);
  const lastRequestedWarehouseVersion = useRef<{
    scope: string;
    warehouseVersion: number;
  } | null>(null);
  const lastWarehouseRefresh = useRef({ scope: headTrackingScope, updatedAt: 0 });

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
    void headsQuery.refetch();
  }, [headTrackingScope, headsQuery.refetch, includeSessionHeads, warehouseVersion]);

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
    void sessionsQuery.refetch();
  }, [headTrackingScope, heads, headsQuery.dataUpdatedAt, sessionsQuery.refetch]);

  const nextBefore = sessionsQuery.data?.pages.at(-1)?.nextBefore ?? null;
  const waitingForFirstRows =
    sessions.length === 0 &&
    (sessionsQuery.isPending || (includeSessionHeads && headsQuery.isPending));
  const loadState: SessionListLoadState = waitingForFirstRows
    ? "loading"
    : sessionsQuery.isFetchingNextPage
      ? "loading_more"
      : "idle";
  const sessionsError = sessionsQuery.error === null ? "" : readErrorMessage(sessionsQuery.error);
  const headsError = headsQuery.error === null ? "" : readErrorMessage(headsQuery.error);
  const error =
    sessionsError || (warehouseSessions.length === 0 && heads.length === 0 ? headsError : "");

  return {
    analyticsAreStale:
      hasStaleAnalytics(sessionPages) || countriesQuery.data?.analyticsState === "stale",
    countries: countriesQuery.data?.breakdowns.country ?? [],
    countryQueryFailed: countriesQuery.isError,
    countryQueryPending: countriesQuery.isPending,
    error,
    hasMore: canLoadMore(nextBefore),
    isRefreshing:
      (sessionsQuery.isFetching && !sessionsQuery.isPending && !sessionsQuery.isFetchingNextPage) ||
      headsQuery.isFetching,
    loadMore: async () => {
      if (!canLoadMore(nextBefore) || loadState !== "idle") return;
      await sessionsQuery.fetchNextPage();
    },
    loadState,
    refresh: () => {
      void sessionsQuery.refetch();
      if (includeSessionHeads) void headsQuery.refetch();
    },
    retry: () => void sessionsQuery.refetch(),
    sessions,
  };
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
