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
    if (
      typeof invalidKey !== "string" ||
      !sessionFilterQueryKeys.includes(invalidKey as (typeof sessionFilterQueryKeys)[number])
    ) {
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

export function dateRangeFilter(
  filter: SessionFilter,
  range: DateRangeValue,
  now: number,
): SessionFilter {
  const option = dateRangeOptions.find((item) => item.value === range) ?? dateRangeOptions[0];
  const to = Math.floor(now / 60_000) * 60_000;
  return { ...filter, from: to - option.durationMs, to };
}

export function selectedDateRange(filter: SessionFilter): DateRangeValue | "custom" {
  if (filter.from === undefined || filter.to === undefined) return "24h";
  const duration = filter.to - filter.from;
  return dateRangeOptions.find((option) => option.durationMs === duration)?.value ?? "custom";
}

export function canonicalSessionFilter(filter: SessionFilter): string {
  return encodeSessionFilter(filter).toString();
}
