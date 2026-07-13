import { z } from "zod";

const MAX_FILTER_VALUE_CHARS = 200;
const MAX_ENTRY_URL_PREFIX_CHARS = 2048;
const DEFAULT_ANALYTICS_DATE_RANGE_MS = 24 * 60 * 60 * 1000;
export const MAX_ANALYTICS_DATE_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

export const sessionFilterQueryKeys = [
  "from",
  "to",
  "country",
  "region",
  "device",
  "browser",
  "os",
  "entry_url",
  "entry_url_prefix",
  "has_errors",
  "error_detail",
  "has_page_coverage",
  "has_rage",
  "has_quick_back",
  "has_insights",
  "min_duration_ms",
  "warehouse_version",
] as const;

export type SessionFilterQueryKey = (typeof sessionFilterQueryKeys)[number];

const optionalEpochMsSchema = z.preprocess(
  parseOptionalIntegerInput,
  z.number().int().safe().nonnegative().optional(),
);
const optionalFilterValueSchema = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).max(MAX_FILTER_VALUE_CHARS).optional(),
);
const optionalEntryUrlPrefixSchema = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).max(MAX_ENTRY_URL_PREFIX_CHARS).optional(),
);
const optionalBooleanSchema = z.preprocess(parseOptionalBooleanInput, z.boolean().optional());

const analyticsDateRangeSchema = z
  .object({ from: optionalEpochMsSchema, to: optionalEpochMsSchema })
  .refine(dateRangeIsOrdered, {
    message: "from must be before or equal to to",
    path: ["to"],
  })
  .refine(dateRangeFitsLimit, {
    message: "date range must be 31 days or less",
    path: ["to"],
  });

export const sessionFilterSchema = z
  .object({
    from: optionalEpochMsSchema,
    to: optionalEpochMsSchema,
    country: optionalFilterValueSchema,
    region: optionalFilterValueSchema,
    device: optionalFilterValueSchema,
    browser: optionalFilterValueSchema,
    os: optionalFilterValueSchema,
    entry_url: optionalEntryUrlPrefixSchema,
    entry_url_prefix: optionalEntryUrlPrefixSchema,
    has_errors: optionalBooleanSchema,
    error_detail: optionalFilterValueSchema,
    has_page_coverage: optionalBooleanSchema,
    has_rage: optionalBooleanSchema,
    has_quick_back: optionalBooleanSchema,
    has_insights: optionalBooleanSchema,
    min_duration_ms: optionalEpochMsSchema,
    /** Verified analytics export sequence shared by a metric and its recording list. */
    warehouse_version: optionalEpochMsSchema,
  })
  .strict()
  .refine(dateRangeIsOrdered, {
    message: "from must be before or equal to to",
    path: ["to"],
  })
  .refine(dateRangeFitsLimit, {
    message: "date range must be 31 days or less",
    path: ["to"],
  });

export type SessionFilter = z.output<typeof sessionFilterSchema>;

export type ParsedSessionFilter =
  | { ok: true; filter: SessionFilter }
  | { ok: false; error: string };

export function parseSessionFilterQuery(params: URLSearchParams): ParsedSessionFilter {
  const input: Record<string, string | undefined> = {};

  for (const key of sessionFilterQueryKeys) {
    const values = params.getAll(key);
    if (values.length > 1) {
      return { ok: false, error: `invalid_${key}` };
    }
    input[key] = values[0];
  }

  const parsed = sessionFilterSchema.safeParse(input);
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.path[0];
    return {
      ok: false,
      error:
        typeof key === "string" && sessionFilterQueryKeys.includes(key as SessionFilterQueryKey)
          ? `invalid_${key}`
          : "invalid_session_filter",
    };
  }

  return { ok: true, filter: parsed.data };
}

export function encodeSessionFilter(filter: SessionFilter): URLSearchParams {
  const parsed = sessionFilterSchema.parse(filter);
  const params = new URLSearchParams();

  for (const key of sessionFilterQueryKeys) {
    const value = parsed[key];
    if (value === undefined) {
      continue;
    }
    params.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }

  return params;
}

/**
 * Keeps analytics reads bounded when a client omits either date boundary.
 * The minute boundary makes repeated requests share one stable cache key.
 */
export function withDefaultAnalyticsDateRange<Filter extends SessionFilter>(
  filter: Filter,
  now: number,
): Filter & { from: number; to: number } {
  const checkedDates = analyticsDateRangeSchema.parse({ from: filter.from, to: filter.to });
  const checkedFilter = { ...filter, ...checkedDates };

  if (checkedFilter.from !== undefined && checkedFilter.to !== undefined) {
    return checkedFilter as Filter & { from: number; to: number };
  }
  if (checkedFilter.from !== undefined) {
    return {
      ...checkedFilter,
      to: Math.min(Number.MAX_SAFE_INTEGER, checkedFilter.from + DEFAULT_ANALYTICS_DATE_RANGE_MS),
    } as Filter & { from: number; to: number };
  }
  if (checkedFilter.to !== undefined) {
    return {
      ...checkedFilter,
      from: Math.max(0, checkedFilter.to - DEFAULT_ANALYTICS_DATE_RANGE_MS),
    } as Filter & { from: number; to: number };
  }

  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Analytics date range received an invalid current time.");
  }

  const to = Math.floor(now / ONE_MINUTE_MS) * ONE_MINUTE_MS;
  return {
    ...checkedFilter,
    from: Math.max(0, to - DEFAULT_ANALYTICS_DATE_RANGE_MS),
    to,
  } as Filter & { from: number; to: number };
}

function dateRangeIsOrdered(filter: { from?: number; to?: number }): boolean {
  return filter.from === undefined || filter.to === undefined || filter.from <= filter.to;
}

function dateRangeFitsLimit(filter: { from?: number; to?: number }): boolean {
  return (
    filter.from === undefined ||
    filter.to === undefined ||
    filter.to - filter.from <= MAX_ANALYTICS_DATE_RANGE_MS
  );
}

function emptyStringToUndefined(value: unknown): unknown {
  return value === "" || value === undefined ? undefined : value;
}

function parseOptionalIntegerInput(value: unknown): unknown {
  if (value === "" || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return value;
  }
  return Number(value);
}

function parseOptionalBooleanInput(value: unknown): unknown {
  if (value === "" || value === undefined) {
    return undefined;
  }
  if (value === "1") {
    return true;
  }
  if (value === "0") {
    return false;
  }
  return value;
}
