import * as v from "valibot";
import { schemaCheck, sharedSchema } from "./validation.ts";

const MAX_FILTER_VALUE_CHARS = 200;
const MAX_ENTRY_URL_PREFIX_CHARS = 2048;
const DEFAULT_ANALYTICS_DATE_RANGE_MS = 24 * 60 * 60 * 1000;
export const MAX_ANALYTICS_DATE_RANGE_MS = 730 * 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

export const sessionFilterQueryKeys = [
  "from",
  "to",
  "country",
  "region",
  "city",
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

const wholeNumberSchema = v.pipe(v.number(), v.integer(), v.safeInteger(), v.minValue(0));
const optionalEpochMsSchema = v.optional(
  v.pipe(v.unknown(), v.transform(parseOptionalIntegerInput), v.optional(wholeNumberSchema)),
);
const filterValueSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(MAX_FILTER_VALUE_CHARS),
);
const optionalFilterValueSchema = v.optional(
  v.pipe(v.unknown(), v.transform(emptyStringToUndefined), v.optional(filterValueSchema)),
);
const countryCodePattern = /^(?:[A-Z]{2}|T1)$/;
const countryCodeMessage = "Use a two-character country code.";
const countryCodeWireSchema = v.pipe(v.string(), v.regex(countryCodePattern, countryCodeMessage));
export const countryCodeSchema = sharedSchema(
  v.pipe(v.string(), v.trim(), v.toUpperCase(), v.regex(countryCodePattern, countryCodeMessage)),
);
const optionalCountryCodeSchema = v.optional(
  v.pipe(v.unknown(), v.transform(emptyStringToUndefined), v.optional(countryCodeSchema)),
);
const entryUrlPrefixSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(MAX_ENTRY_URL_PREFIX_CHARS),
);
const optionalEntryUrlPrefixSchema = v.optional(
  v.pipe(v.unknown(), v.transform(emptyStringToUndefined), v.optional(entryUrlPrefixSchema)),
);
const optionalBooleanSchema = v.optional(
  v.pipe(v.unknown(), v.transform(parseOptionalBooleanInput), v.optional(v.boolean())),
);

const analyticsDateRangeBaseSchema = v.object({
  from: optionalEpochMsSchema,
  to: optionalEpochMsSchema,
});
const analyticsDateRangeSchema = sharedSchema(
  v.pipe(
    analyticsDateRangeBaseSchema,
    checkDateRange<v.InferOutput<typeof analyticsDateRangeBaseSchema>>(),
  ),
);

const sessionFilterBaseSchema = v.strictObject({
  from: optionalEpochMsSchema,
  to: optionalEpochMsSchema,
  country: optionalCountryCodeSchema,
  region: optionalFilterValueSchema,
  city: optionalFilterValueSchema,
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
});
export const sessionFilterSchema = sharedSchema(
  v.pipe(sessionFilterBaseSchema, checkDateRange<v.InferOutput<typeof sessionFilterBaseSchema>>()),
);

/**
 * Response filters are already typed values from the server. Validate them
 * without normalizing strings so a decoded response keeps the exact wire value
 * used by its labels and metric doorways.
 */
const responseFilterValueSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_FILTER_VALUE_CHARS),
);
const responseEntryUrlSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_ENTRY_URL_PREFIX_CHARS),
);
const responseSessionFilterBaseSchema = v.strictObject({
  from: v.optional(wholeNumberSchema),
  to: v.optional(wholeNumberSchema),
  country: v.optional(countryCodeWireSchema),
  region: v.optional(responseFilterValueSchema),
  city: v.optional(responseFilterValueSchema),
  device: v.optional(responseFilterValueSchema),
  browser: v.optional(responseFilterValueSchema),
  os: v.optional(responseFilterValueSchema),
  entry_url: v.optional(responseEntryUrlSchema),
  entry_url_prefix: v.optional(responseEntryUrlSchema),
  has_errors: v.optional(v.boolean()),
  error_detail: v.optional(responseFilterValueSchema),
  has_page_coverage: v.optional(v.boolean()),
  has_rage: v.optional(v.boolean()),
  has_quick_back: v.optional(v.boolean()),
  has_insights: v.optional(v.boolean()),
  min_duration_ms: v.optional(wholeNumberSchema),
  warehouse_version: v.optional(wholeNumberSchema),
});
export const responseSessionFilterSchema = sharedSchema(
  v.pipe(
    responseSessionFilterBaseSchema,
    checkDateRange<v.InferOutput<typeof responseSessionFilterBaseSchema>>(),
  ),
);

export type SessionFilter = v.InferOutput<typeof sessionFilterSchema>;

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

function checkDateRange<Input extends { from?: number; to?: number }>(): v.RawCheckAction<Input> {
  return schemaCheck<Input>((filter, context) => {
    if (!dateRangeIsOrdered(filter)) {
      context.addIssue({
        message: "from must be before or equal to to",
        path: ["to"],
      });
    }
    if (!dateRangeFitsLimit(filter)) {
      context.addIssue({
        message: "date range must be 730 days or less",
        path: ["to"],
      });
    }
  });
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
