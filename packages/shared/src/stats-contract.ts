import * as v from "valibot";
import {
  responseSessionFilterSchema as responseSessionFilterValueSchema,
  sessionFilterQueryKeys,
  type SessionFilter,
} from "./session-filter.ts";
import { schemaCheck, sharedSchema, type ValidationContext } from "./validation.ts";

const responseSessionFilterSchema = v.pipe(
  v.unknown(),
  v.transform(stripUnknownSessionFilterKeys),
  responseSessionFilterValueSchema,
);

const finiteNumberSchema = v.pipe(v.number(), v.finite());
const wholeNumberSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const analyticsStateSchema = sharedSchema(
  v.picklist(["fresh", "stale", "compare", "d1_rollback", "d1_residency"]),
);

export const filteredNumberSchema = sharedSchema(
  v.object({
    value: finiteNumberSchema,
    filter: responseSessionFilterSchema,
  }),
);

export const filteredOptionalNumberSchema = sharedSchema(
  v.object({
    value: v.nullable(finiteNumberSchema),
    filter: responseSessionFilterSchema,
  }),
);

export const statsBreakdownRowSchema = sharedSchema(
  v.object({
    label: v.string(),
    /** Present on city rows only: the ISO country code the city belongs to,
     * since city names are not unique across countries. */
    country: v.optional(v.string()),
    filter: responseSessionFilterSchema,
    count: filteredNumberSchema,
    share: filteredNumberSchema,
  }),
);

export const statsErrorGroupSchema = sharedSchema(
  v.object({
    detail: v.string(),
    filter: responseSessionFilterSchema,
    count: filteredNumberSchema,
    affectedSessions: filteredNumberSchema,
  }),
);

const finalizedProjectStatsObjectSchema = v.object({
  filter: responseSessionFilterSchema,
  sessions: filteredNumberSchema,
  duration: v.object({
    average: filteredNumberSchema,
    p50: filteredNumberSchema,
  }),
  clicks: filteredNumberSchema,
  pagesPerSession: v.object({
    value: v.nullable(finiteNumberSchema),
    filter: responseSessionFilterSchema,
    includedSessions: filteredNumberSchema,
    totalSessions: filteredNumberSchema,
  }),
  insights: v.object({
    ragePercent: filteredOptionalNumberSchema,
    quickBackPercent: filteredOptionalNumberSchema,
    averageInteractionTimeMs: filteredOptionalNumberSchema,
    averageMaxScrollDepth: filteredOptionalNumberSchema,
    includedSessions: filteredNumberSchema,
    totalSessions: filteredNumberSchema,
  }),
  breakdowns: v.object({
    country: v.array(statsBreakdownRowSchema),
    region: v.array(statsBreakdownRowSchema),
    city: v.array(statsBreakdownRowSchema),
    device: v.array(statsBreakdownRowSchema),
    browser: v.array(statsBreakdownRowSchema),
    os: v.array(statsBreakdownRowSchema),
    entryPage: v.array(statsBreakdownRowSchema),
  }),
  errors: v.array(statsErrorGroupSchema),
});

const analyticsMetadataShape = {
  warehouseVersion: v.optional(wholeNumberSchema),
  analyticsState: v.optional(analyticsStateSchema),
} as const;

export const finalizedProjectStatsSchema = sharedSchema(
  v.pipe(finalizedProjectStatsObjectSchema, schemaCheck(validateFinalizedStatsDoorways)),
);

export const projectStatsSchema = sharedSchema(
  v.pipe(
    v.object({ ...finalizedProjectStatsObjectSchema.entries, liveNow: filteredNumberSchema }),
    schemaCheck((stats, context) => {
      validateFinalizedStatsDoorways(stats, context);
      requireSameFilter(context, ["liveNow", "filter"], stats.filter, stats.liveNow.filter);
    }),
  ),
);

export const finalizedProjectStatsResponseSchema = sharedSchema(
  v.pipe(
    v.object({ ...finalizedProjectStatsObjectSchema.entries, ...analyticsMetadataShape }),
    schemaCheck((stats, context) => {
      validateFinalizedStatsDoorways(stats, context);
      validateAnalyticsMetadata(stats, context);
    }),
  ),
);

export const projectStatsResponseSchema = sharedSchema(
  v.pipe(
    v.object({
      ...finalizedProjectStatsObjectSchema.entries,
      liveNow: filteredNumberSchema,
      ...analyticsMetadataShape,
    }),
    schemaCheck((stats, context) => {
      validateFinalizedStatsDoorways(stats, context);
      requireSameFilter(context, ["liveNow", "filter"], stats.filter, stats.liveNow.filter);
      validateAnalyticsMetadata(stats, context);
    }),
  ),
);

export type AnalyticsState = v.InferOutput<typeof analyticsStateSchema>;
export type FilteredNumber = v.InferOutput<typeof filteredNumberSchema>;
export type FilteredOptionalNumber = v.InferOutput<typeof filteredOptionalNumberSchema>;
export type StatsBreakdownRow = v.InferOutput<typeof statsBreakdownRowSchema>;
export type StatsErrorGroup = v.InferOutput<typeof statsErrorGroupSchema>;
export type FinalizedProjectStats = v.InferOutput<typeof finalizedProjectStatsSchema>;
export type ProjectStats = v.InferOutput<typeof projectStatsSchema>;
export type FinalizedProjectStatsResponse = v.InferOutput<
  typeof finalizedProjectStatsResponseSchema
>;
export type ProjectStatsResponse = v.InferOutput<typeof projectStatsResponseSchema>;

export function decodeProjectStatsResponse(value: unknown): ProjectStatsResponse {
  return projectStatsResponseSchema.parse(value);
}

type FinalizedProjectStatsObject = v.InferOutput<typeof finalizedProjectStatsObjectSchema>;

function validateFinalizedStatsDoorways(
  stats: FinalizedProjectStatsObject,
  context: ValidationContext,
): void {
  requireSameFilter(context, ["sessions", "filter"], stats.filter, stats.sessions.filter);
  requireSameFilter(
    context,
    ["duration", "average", "filter"],
    stats.filter,
    stats.duration.average.filter,
  );
  requireSameFilter(
    context,
    ["duration", "p50", "filter"],
    stats.filter,
    stats.duration.p50.filter,
  );
  requireSameFilter(context, ["clicks", "filter"], stats.filter, stats.clicks.filter);
  requireSameFilter(
    context,
    ["pagesPerSession", "totalSessions", "filter"],
    stats.filter,
    stats.pagesPerSession.totalSessions.filter,
  );
  const pageFilter = { ...stats.filter, has_page_coverage: true } satisfies SessionFilter;
  requireSameFilter(
    context,
    ["pagesPerSession", "filter"],
    pageFilter,
    stats.pagesPerSession.filter,
  );
  requireSameFilter(
    context,
    ["pagesPerSession", "includedSessions", "filter"],
    pageFilter,
    stats.pagesPerSession.includedSessions.filter,
  );

  const insightFilter = { ...stats.filter, has_insights: true } satisfies SessionFilter;
  const rageFilter = { ...stats.filter, has_rage: true } satisfies SessionFilter;
  const quickBackFilter = { ...stats.filter, has_quick_back: true } satisfies SessionFilter;
  requireSameFilter(
    context,
    ["insights", "ragePercent", "filter"],
    rageFilter,
    stats.insights.ragePercent.filter,
  );
  requireSameFilter(
    context,
    ["insights", "quickBackPercent", "filter"],
    quickBackFilter,
    stats.insights.quickBackPercent.filter,
  );
  for (const key of [
    "averageInteractionTimeMs",
    "averageMaxScrollDepth",
    "includedSessions",
  ] as const) {
    requireSameFilter(
      context,
      ["insights", key, "filter"],
      insightFilter,
      stats.insights[key].filter,
    );
  }
  requireSameFilter(
    context,
    ["insights", "totalSessions", "filter"],
    stats.filter,
    stats.insights.totalSessions.filter,
  );

  for (const key of ["country", "region", "device", "browser", "os"] as const) {
    for (const [index, row] of stats.breakdowns[key].entries()) {
      const expected = { ...stats.filter, [key]: row.label } satisfies SessionFilter;
      validateBreakdownRow(context, ["breakdowns", key, index], expected, row);
    }
  }
  for (const [index, row] of stats.breakdowns.city.entries()) {
    // City rows pin both keys: city names are only unique within a country.
    const expected = {
      ...stats.filter,
      country: row.country,
      city: row.label,
    } satisfies SessionFilter;
    if (row.country === undefined) {
      context.addIssue({
        message: "city breakdown rows must carry their country",
        path: ["breakdowns", "city", index, "country"],
      });
    }
    validateBreakdownRow(context, ["breakdowns", "city", index], expected, row);
  }
  for (const [index, row] of stats.breakdowns.entryPage.entries()) {
    const expected = { ...stats.filter, entry_url: row.label } satisfies SessionFilter;
    validateBreakdownRow(context, ["breakdowns", "entryPage", index], expected, row);
  }
  for (const [index, error] of stats.errors.entries()) {
    const expected = { ...stats.filter, error_detail: error.detail } satisfies SessionFilter;
    requireSameFilter(context, ["errors", index, "filter"], expected, error.filter);
    requireSameFilter(context, ["errors", index, "count", "filter"], expected, error.count.filter);
    requireSameFilter(
      context,
      ["errors", index, "affectedSessions", "filter"],
      expected,
      error.affectedSessions.filter,
    );
  }
}

function validateBreakdownRow(
  context: ValidationContext,
  path: Array<string | number>,
  expected: SessionFilter,
  row: StatsBreakdownRow,
): void {
  requireSameFilter(context, [...path, "filter"], expected, row.filter);
  requireSameFilter(context, [...path, "count", "filter"], expected, row.count.filter);
  requireSameFilter(context, [...path, "share", "filter"], expected, row.share.filter);
}

function validateAnalyticsMetadata(
  stats: {
    filter: SessionFilter;
    warehouseVersion?: number;
    analyticsState?: AnalyticsState;
  },
  context: ValidationContext,
): void {
  if (
    (stats.analyticsState === "fresh" || stats.analyticsState === "stale") &&
    stats.warehouseVersion === undefined
  ) {
    context.addIssue({
      message: "fresh or stale analytics must identify its warehouse version",
      path: ["warehouseVersion"],
    });
  }
  if (
    stats.warehouseVersion !== undefined &&
    stats.filter.warehouse_version !== stats.warehouseVersion
  ) {
    context.addIssue({
      message: "stats filters must use the response warehouse version",
      path: ["filter", "warehouse_version"],
    });
  }
}

function requireSameFilter(
  context: ValidationContext,
  path: Array<string | number>,
  expected: SessionFilter,
  actual: SessionFilter,
): void {
  if (sameFilter(expected, actual)) return;
  context.addIssue({
    message: "metric doorway filter does not match its session set",
    path,
  });
}

function sameFilter(left: SessionFilter, right: SessionFilter): boolean {
  return sessionFilterQueryKeys.every((key) => left[key] === right[key]);
}

function stripUnknownSessionFilterKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;

  const input = value as Record<string, unknown>;
  const known: Record<string, unknown> = {};
  for (const key of sessionFilterQueryKeys) {
    if (key in input) known[key] = input[key];
  }
  return known;
}
