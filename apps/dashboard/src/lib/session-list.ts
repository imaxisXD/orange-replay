import type { SessionFilter } from "@orange-replay/shared";
import type {
  ListSessionsResponse,
  SessionActivity,
  SessionDetailsState,
  SessionHead,
  SessionListItem,
  SessionReplaySource,
} from "@/lib/api";
import type { SessionSort } from "./sessions-view-search";

export type SessionRowSource = "r2" | "d1" | "provisional";

export interface SessionDisplayItem extends SessionListItem {
  activity: SessionActivity;
  details_state: SessionDetailsState;
  replay_source: SessionReplaySource;
  row_source: SessionRowSource;
}

export interface SessionPageParam {
  before: string | null;
  warehouseVersion?: number;
}

export function appendUniqueSessions(
  currentSessions: SessionListItem[],
  nextSessions: SessionListItem[],
): SessionListItem[] {
  const seenIds = new Set(currentSessions.map((session) => session.session_id));
  const merged = [...currentSessions];

  for (const session of nextSessions) {
    if (seenIds.has(session.session_id)) continue;
    seenIds.add(session.session_id);
    merged.push(session);
  }

  return merged;
}

/**
 * Combines the immutable warehouse page with the faster control-plane rows.
 * The warehouse cursor stays outside this function and is never changed.
 */
export function mergeSessionRows(
  warehouseSessions: readonly SessionListItem[],
  heads: readonly SessionHead[],
  sort: SessionSort,
): SessionDisplayItem[] {
  const rows = new Map<string, SessionDisplayItem>();

  for (const head of heads) {
    const candidate = displayHead(head);
    const current = rows.get(head.session_id);
    if (
      current === undefined ||
      sourceRank(candidate.row_source) > sourceRank(current.row_source)
    ) {
      rows.set(head.session_id, candidate);
    }
  }

  for (const session of warehouseSessions) {
    rows.set(session.session_id, displayWarehouseSession(session));
  }

  return [...rows.values()].sort(sessionComparator(sort));
}

/** A pinned warehouse result must stay an exact snapshot. */
export function canMergeSessionHeads(filter: SessionFilter, sort: SessionSort = "newest"): boolean {
  if (filter.warehouse_version !== undefined) return false;
  if (sort !== "newest" && sort !== "duration") return false;
  return !hasExactOnlyHeadFilter(filter);
}

/**
 * The warehouse page keeps one fixed date snapshot so its cursor stays exact.
 * The default Sessions view still needs to see sessions that start after that
 * snapshot was opened, so only its fast head overlay leaves the upper date
 * open. A date chosen in the URL stays fixed.
 */
export function sessionHeadsFilter(
  warehouseFilter: SessionFilter,
  urlFilter: SessionFilter,
  warehouseVersion: number | undefined,
): SessionFilter {
  const usesRollingDefault = urlFilter.from === undefined && urlFilter.to === undefined;
  const headFilter = usesRollingDefault
    ? withoutUpperDate(warehouseFilter)
    : { ...warehouseFilter };

  return warehouseVersion === undefined
    ? headFilter
    : { ...headFilter, warehouse_version: warehouseVersion };
}

export function canLoadMore(nextBefore: string | null): boolean {
  return nextBefore !== null && nextBefore.length > 0;
}

export function nextSessionPageParam(
  lastPage: ListSessionsResponse,
  pages: ListSessionsResponse[],
): SessionPageParam | undefined {
  if (!canLoadMore(lastPage.nextBefore)) return undefined;

  const warehouseVersion = pages[0]?.warehouseVersion;
  return {
    before: lastPage.nextBefore,
    ...(warehouseVersion === undefined ? {} : { warehouseVersion }),
  };
}

export function hasStaleAnalytics(pages: ListSessionsResponse[]): boolean {
  return pages.some((page) => page.analyticsState === "stale");
}

export function nextTrackedSessionHeadIds(
  previousTrackedSessionIds: readonly string[],
  heads: readonly SessionHead[],
  warehouseSessions: readonly SessionListItem[],
): string[] {
  const warehouseSessionIds = new Set(warehouseSessions.map((session) => session.session_id));
  const returnedHeadIds = new Set(heads.map((session) => session.session_id));
  const trackedSessionIds: string[] = [];
  const seen = new Set<string>();

  for (const sessionId of previousTrackedSessionIds) {
    if (trackedSessionIds.length === 100) break;
    if (
      returnedHeadIds.has(sessionId) &&
      !warehouseSessionIds.has(sessionId) &&
      !seen.has(sessionId)
    ) {
      seen.add(sessionId);
      trackedSessionIds.push(sessionId);
    }
  }
  for (const session of heads) {
    if (trackedSessionIds.length === 100) break;
    if (warehouseSessionIds.has(session.session_id) || seen.has(session.session_id)) continue;
    seen.add(session.session_id);
    trackedSessionIds.push(session.session_id);
  }
  return trackedSessionIds;
}

function displayHead(head: SessionHead): SessionDisplayItem {
  return {
    ...head,
    row_source: head.details_state === "exact" ? "d1" : "provisional",
  };
}

function hasExactOnlyHeadFilter(filter: SessionFilter): boolean {
  return (
    filter.has_errors !== undefined ||
    filter.error_detail !== undefined ||
    filter.has_page_coverage !== undefined ||
    filter.has_rage !== undefined ||
    filter.has_quick_back !== undefined ||
    filter.has_insights !== undefined
  );
}

function displayWarehouseSession(session: SessionListItem): SessionDisplayItem {
  return {
    ...session,
    activity: "complete",
    details_state: "exact",
    replay_source: "recorded",
    row_source: "r2",
  };
}

function sourceRank(source: SessionRowSource): number {
  if (source === "r2") return 3;
  if (source === "d1") return 2;
  return 1;
}

function sessionComparator(
  sort: SessionSort,
): (left: SessionDisplayItem, right: SessionDisplayItem) => number {
  return (left, right) => {
    if (sort === "pages") {
      const pageComparison = compareOptionalNumberDescending(left.page_count, right.page_count);
      if (pageComparison !== 0) return pageComparison;
    } else {
      const valueComparison = numericSortValue(right, sort) - numericSortValue(left, sort);
      if (valueComparison !== 0) return valueComparison;
    }

    return right.session_id.localeCompare(left.session_id);
  };
}

function numericSortValue(
  session: SessionDisplayItem,
  sort: Exclude<SessionSort, "pages">,
): number {
  if (sort === "newest") return session.started_at;
  if (sort === "friction") return session.errors * 1_000 + session.rages * 100 + session.clicks;
  if (sort === "duration") return session.duration_ms;
  return session.clicks;
}

function compareOptionalNumberDescending(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return right - left;
}

function withoutUpperDate(filter: SessionFilter): SessionFilter {
  const { to: _to, ...withoutTo } = filter;
  return withoutTo;
}
