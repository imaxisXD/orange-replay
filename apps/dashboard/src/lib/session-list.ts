import type { ListSessionsResponse, SessionListItem } from "@/lib/api";

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
