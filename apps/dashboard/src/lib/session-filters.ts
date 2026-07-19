import {
  encodeSessionFilter,
  sessionFilterQueryKeys,
  sessionFilterSchema,
  withDefaultAnalyticsDateRange,
  type SessionFilter,
} from "@orange-replay/shared";

export const dateRangeOptions = [
  { label: "Last 24h", value: "24h", durationMs: 24 * 60 * 60 * 1000 },
  { label: "3d", value: "3d", durationMs: 3 * 24 * 60 * 60 * 1000 },
  { label: "7d", value: "7d", durationMs: 7 * 24 * 60 * 60 * 1000 },
  { label: "28d", value: "28d", durationMs: 28 * 24 * 60 * 60 * 1000 },
] as const;

export type DateRangeValue = (typeof dateRangeOptions)[number]["value"];

const sessionFilterQueryKeySet = new Set<string>(sessionFilterQueryKeys);

export function validateSessionSearch(search: Record<string, unknown>): SessionFilter {
  const candidate: Record<string, unknown> = {};

  for (const key of sessionFilterQueryKeys) {
    const parsedKey = sessionFilterSchema.safeParse({ [key]: search[key] });
    if (parsedKey.success && parsedKey.data[key] !== undefined) {
      candidate[key] = parsedKey.data[key];
    }
  }

  for (let attempt = 0; attempt <= sessionFilterQueryKeys.length; attempt += 1) {
    const parsed = sessionFilterSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;

    const invalidKey = parsed.error.issues[0]?.path[0];
    if (typeof invalidKey !== "string" || !sessionFilterQueryKeySet.has(invalidKey)) {
      return {};
    }
    delete candidate[invalidKey];
  }

  return {};
}

export function withDefaultDateRange(filter: SessionFilter, now: number): SessionFilter {
  return withDefaultAnalyticsDateRange(filter, now);
}

export function dateRangeSnapshotFilter(filter: SessionFilter): SessionFilter {
  return {
    ...(filter.from === undefined ? {} : { from: filter.from }),
    ...(filter.to === undefined ? {} : { to: filter.to }),
    ...(filter.warehouse_version === undefined
      ? {}
      : { warehouse_version: filter.warehouse_version }),
  };
}

/**
 * The date range is dashboard-level state: top-nav tab switches carry an
 * explicitly chosen from/to window while dropping page-local keys (lenses,
 * selection, sort). The silent 24h default carries nothing, so untouched
 * URLs stay clean and each page applies its own default.
 */
export function carriedDateRangeSearch(search: Record<string, unknown>): SessionFilter {
  const filter = validateSessionSearch(search);
  return {
    ...(filter.from === undefined ? {} : { from: filter.from }),
    ...(filter.to === undefined ? {} : { to: filter.to }),
  };
}

const TWENTY_EIGHT_DAYS_MS = 28 * 24 * 60 * 60 * 1000;

export function dateRangeFilter(
  filter: SessionFilter,
  range: DateRangeValue,
  now: number,
): SessionFilter {
  const option = dateRangeOptions.find((item) => item.value === range) ?? dateRangeOptions[0];
  const to = Math.floor(now / 60_000) * 60_000;
  // Choosing a preset is a SessionFilter mutation: it drops the doorway URL
  // warehouse pin so the new window sees live and newly finalized recordings.
  // This protects both the Overview and Sessions range selectors.
  const { warehouse_version: _pin, ...rest } = filter;
  return { ...rest, from: to - option.durationMs, to };
}

/**
 * True when the effective window is shorter than 28 days, so a "Show last 28
 * days" action would genuinely widen it. A 28-day or longer/wider window (or a
 * custom window that is not shorter than 28 days) gets no widen action it
 * cannot fulfil.
 */
export function windowShorterThan28Days(filter: SessionFilter): boolean {
  if (filter.from === undefined || filter.to === undefined) return true;
  return filter.to - filter.from < TWENTY_EIGHT_DAYS_MS;
}

export function selectedDateRange(filter: SessionFilter): DateRangeValue | "custom" {
  if (filter.from === undefined || filter.to === undefined) return "24h";
  const duration = filter.to - filter.from;
  return dateRangeOptions.find((option) => option.durationMs === duration)?.value ?? "custom";
}

export function canonicalSessionFilter(filter: SessionFilter): string {
  return encodeSessionFilter(filter).toString();
}
