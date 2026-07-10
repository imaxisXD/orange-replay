const MAX_WATCHED = 1_000;

function storageKey(projectId: string): string {
  return `or:watched:${projectId}`;
}

export function watchedSessionIds(projectId: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

export function markSessionWatched(projectId: string, sessionId: string): void {
  try {
    const current = [...watchedSessionIds(projectId)].filter((id) => id !== sessionId);
    current.push(sessionId);
    localStorage.setItem(storageKey(projectId), JSON.stringify(current.slice(-MAX_WATCHED)));
  } catch {
    // Storage unavailable (private mode, quota) — watched state is a nicety.
  }
}
