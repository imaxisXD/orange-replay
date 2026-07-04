import type { SessionListItem } from "@/lib/api";

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
