export const ACTIVITY_BUCKETS = 8;

const MAX_LEVEL = 15;
const HIST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{2}$/;

export interface ActivityHist {
  levels: number[];
  errors: boolean[];
}

export function decodeActivityHist(value: string | null | undefined): ActivityHist | null {
  if (value === null || value === undefined || !HIST_PATTERN.test(value)) return null;

  const levels = Array.from(value.slice(0, ACTIVITY_BUCKETS), (char) => Number.parseInt(char, 16));
  const errorMask = Number.parseInt(value.slice(ACTIVITY_BUCKETS + 1), 16);
  const errors = levels.map((_, index) => ((errorMask >> index) & 1) === 1);
  return { levels, errors };
}

/**
 * Max-normalizes raw bucket counts to 0-15 levels (a non-empty bucket never
 * rounds down to 0) and encodes 8 hex level digits + "-" + 2 hex error-mask
 * digits. Null when the session produced no events at all.
 */
export function encodeActivityHist(
  counts: readonly number[],
  errors: readonly boolean[],
): string | null {
  if (counts.length !== ACTIVITY_BUCKETS || errors.length !== ACTIVITY_BUCKETS) return null;

  const max = Math.max(...counts);
  if (max <= 0) return null;

  const levelChars = counts
    .map((count) => (count <= 0 ? 0 : Math.max(1, Math.round((count / max) * MAX_LEVEL))))
    .map((level) => level.toString(16))
    .join("");

  let errorMask = 0;
  for (let index = 0; index < ACTIVITY_BUCKETS; index += 1) {
    if (errors[index] === true) errorMask |= 1 << index;
  }

  return `${levelChars}-${errorMask.toString(16).padStart(2, "0")}`;
}

/**
 * Streaming bucket accumulator for the finalize pass: constant memory, one
 * add() per index event, absolute epoch-ms timestamps.
 */
export class ActivityHistAccumulator {
  private readonly counts = Array.from({ length: ACTIVITY_BUCKETS }, () => 0);
  private readonly errors = Array.from({ length: ACTIVITY_BUCKETS }, () => false);
  private readonly startMs: number;
  private readonly spanMs: number;

  constructor(startMs: number, endMs: number) {
    this.startMs = startMs;
    this.spanMs = Math.max(1, endMs - startMs);
  }

  add(t: number, kind: string): void {
    if (!Number.isFinite(t)) return;

    const rawBucket = Math.floor(((t - this.startMs) / this.spanMs) * ACTIVITY_BUCKETS);
    const bucket = Math.min(ACTIVITY_BUCKETS - 1, Math.max(0, rawBucket));
    this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
    if (kind === "error") this.errors[bucket] = true;
  }

  finish(): string | null {
    return encodeActivityHist(this.counts, this.errors);
  }
}
