export function formatSessionCount(count: number, hasMore: boolean): string {
  const noun = sessionCountNoun(count, hasMore);
  return `${count}${hasMore ? "+" : ""} ${noun}`;
}

export function sessionCountNoun(count: number, hasMore: boolean): "session" | "sessions" {
  return count === 1 && !hasMore ? "session" : "sessions";
}

/**
 * Shorthand for an active from/to window, matching the overview picker's
 * buckets (24h / 3d / 7d / 28d). Null when no lower bound is set.
 */
export function dateRangeShorthand(
  filter: { from?: number; to?: number },
  now = Date.now(),
): string | null {
  if (filter.from === undefined) return null;

  const spanMs = (filter.to ?? now) - filter.from;
  if (spanMs <= 0) return null;

  const hours = spanMs / 3_600_000;
  if (hours <= 25) return "24h";

  const days = Math.round(hours / 24);
  return `${days}d`;
}
