import { z } from "zod";

const MAX_FILTER_VALUE_CHARS = 200;
const MAX_ENTRY_URL_PREFIX_CHARS = 2048;

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
  })
  .strict()
  .refine(
    (filter) => filter.from === undefined || filter.to === undefined || filter.from <= filter.to,
    { message: "from must be before or equal to to", path: ["to"] },
  );

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
