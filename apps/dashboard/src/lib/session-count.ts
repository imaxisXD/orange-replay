export function formatSessionCount(count: number, hasMore: boolean): string {
  const noun = sessionCountNoun(count, hasMore);
  return `${count}${hasMore ? "+" : ""} ${noun}`;
}

export function sessionCountNoun(count: number, hasMore: boolean): "session" | "sessions" {
  return count === 1 && !hasMore ? "session" : "sessions";
}
