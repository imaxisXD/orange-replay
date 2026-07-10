import {
  encodeSessionFilter,
  sessionFilterQueryKeys,
  sessionFilterSchema,
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
  if (filter.from !== undefined || filter.to !== undefined) return { ...filter };
  return dateRangeFilter(filter, "24h", now);
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

export function activeFilterLabels(filter: SessionFilter): string[] {
  const labels: string[] = [];
  if (filter.from !== undefined || filter.to !== undefined) labels.push("Date range");
  if (filter.country !== undefined) labels.push(`Country ${filter.country}`);
  if (filter.region !== undefined) labels.push(`Region ${filter.region}`);
  if (filter.device !== undefined) labels.push(filter.device);
  if (filter.browser !== undefined) labels.push(filter.browser);
  if (filter.os !== undefined) labels.push(filter.os);
  if (filter.entry_url !== undefined) labels.push(`Entry ${filter.entry_url}`);
  if (filter.entry_url_prefix !== undefined) {
    labels.push(`Entry starts with ${filter.entry_url_prefix}`);
  }
  if (filter.has_errors === true) labels.push("Has errors");
  if (filter.has_errors === false) labels.push("No errors");
  if (filter.error_detail !== undefined) labels.push(`Error ${filter.error_detail}`);
  if (filter.has_page_coverage === true) labels.push("Page count covered");
  if (filter.has_page_coverage === false) labels.push("Page count not covered");
  if (filter.has_rage === true) labels.push("Has rage clicks");
  if (filter.has_rage === false) labels.push("No rage clicks");
  if (filter.has_quick_back === true) labels.push("Has in-app quick backs");
  if (filter.has_quick_back === false) labels.push("No in-app quick backs");
  if (filter.has_insights === true) labels.push("Insights covered");
  if (filter.has_insights === false) labels.push("Insights not covered");
  if (filter.min_duration_ms !== undefined) {
    labels.push(`At least ${Math.round(filter.min_duration_ms / 1000)}s`);
  }
  return labels;
}
