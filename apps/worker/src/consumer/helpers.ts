export const RETENTION_DAY_MS = 86_400_000;
export const MAX_EVENT_DETAIL_CHARS = 200;

export function usageMonthFromStartedAt(startedAt: number): string {
  return new Date(startedAt).toISOString().slice(0, 7);
}

export function expiresAtFromEndedAt(endedAt: number, retentionDays: number): number {
  return endedAt + retentionDays * RETENTION_DAY_MS;
}

export function durationMsFromTimes(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

export function truncateEventDetail(detail: string | undefined): string | null {
  if (detail === undefined) return null;
  return detail.slice(0, MAX_EVENT_DETAIL_CHARS);
}

export function chunkList<T>(items: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}
