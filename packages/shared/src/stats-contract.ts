import { z } from "zod";
import {
  responseSessionFilterSchema as responseSessionFilterValueSchema,
  sessionFilterQueryKeys,
  type SessionFilter,
} from "./session-filter.ts";

const responseSessionFilterSchema = z.preprocess(
  stripUnknownSessionFilterKeys,
  responseSessionFilterValueSchema,
);

export const analyticsStateSchema = z.enum([
  "fresh",
  "stale",
  "compare",
  "d1_rollback",
  "d1_residency",
]);

export const filteredNumberSchema = z.object({
  value: z.number().finite(),
  filter: responseSessionFilterSchema,
});

export const filteredOptionalNumberSchema = z.object({
  value: z.number().finite().nullable(),
  filter: responseSessionFilterSchema,
});

export const statsBreakdownRowSchema = z.object({
  label: z.string(),
  filter: responseSessionFilterSchema,
  count: filteredNumberSchema,
  share: filteredNumberSchema,
});

export const statsErrorGroupSchema = z.object({
  detail: z.string(),
  filter: responseSessionFilterSchema,
  count: filteredNumberSchema,
  affectedSessions: filteredNumberSchema,
});

const finalizedProjectStatsObjectSchema = z.object({
  filter: responseSessionFilterSchema,
  sessions: filteredNumberSchema,
  duration: z.object({
    average: filteredNumberSchema,
    p50: filteredNumberSchema,
  }),
  clicks: filteredNumberSchema,
  pagesPerSession: z.object({
    value: z.number().finite().nullable(),
    filter: responseSessionFilterSchema,
    includedSessions: filteredNumberSchema,
    totalSessions: filteredNumberSchema,
  }),
  insights: z.object({
    ragePercent: filteredOptionalNumberSchema,
    quickBackPercent: filteredOptionalNumberSchema,
    averageInteractionTimeMs: filteredOptionalNumberSchema,
    averageMaxScrollDepth: filteredOptionalNumberSchema,
    includedSessions: filteredNumberSchema,
    totalSessions: filteredNumberSchema,
  }),
  breakdowns: z.object({
    country: z.array(statsBreakdownRowSchema),
    region: z.array(statsBreakdownRowSchema),
    device: z.array(statsBreakdownRowSchema),
    browser: z.array(statsBreakdownRowSchema),
    os: z.array(statsBreakdownRowSchema),
    entryPage: z.array(statsBreakdownRowSchema),
  }),
  errors: z.array(statsErrorGroupSchema),
});

const analyticsMetadataShape = {
  warehouseVersion: z.number().int().safe().nonnegative().optional(),
  analyticsState: analyticsStateSchema.optional(),
} as const;

export const finalizedProjectStatsSchema = finalizedProjectStatsObjectSchema.superRefine(
  validateFinalizedStatsDoorways,
);

export const projectStatsSchema = finalizedProjectStatsObjectSchema
  .extend({ liveNow: filteredNumberSchema })
  .superRefine((stats, context) => {
    validateFinalizedStatsDoorways(stats, context);
    requireSameFilter(context, ["liveNow", "filter"], stats.filter, stats.liveNow.filter);
  });

export const finalizedProjectStatsResponseSchema = finalizedProjectStatsObjectSchema
  .extend(analyticsMetadataShape)
  .superRefine((stats, context) => {
    validateFinalizedStatsDoorways(stats, context);
    validateAnalyticsMetadata(stats, context);
  });

export const projectStatsResponseSchema = finalizedProjectStatsObjectSchema
  .extend({ liveNow: filteredNumberSchema, ...analyticsMetadataShape })
  .superRefine((stats, context) => {
    validateFinalizedStatsDoorways(stats, context);
    requireSameFilter(context, ["liveNow", "filter"], stats.filter, stats.liveNow.filter);
    validateAnalyticsMetadata(stats, context);
  });

export type AnalyticsState = z.output<typeof analyticsStateSchema>;
export type FilteredNumber = z.output<typeof filteredNumberSchema>;
export type FilteredOptionalNumber = z.output<typeof filteredOptionalNumberSchema>;
export type StatsBreakdownRow = z.output<typeof statsBreakdownRowSchema>;
export type StatsErrorGroup = z.output<typeof statsErrorGroupSchema>;
export type FinalizedProjectStats = z.output<typeof finalizedProjectStatsSchema>;
export type ProjectStats = z.output<typeof projectStatsSchema>;
export type FinalizedProjectStatsResponse = z.output<typeof finalizedProjectStatsResponseSchema>;
export type ProjectStatsResponse = z.output<typeof projectStatsResponseSchema>;

export function decodeProjectStatsResponse(value: unknown): ProjectStatsResponse {
  return projectStatsResponseSchema.parse(value);
}

function validateFinalizedStatsDoorways(
  stats: z.output<typeof finalizedProjectStatsObjectSchema>,
  context: z.core.$RefinementCtx<z.output<typeof finalizedProjectStatsObjectSchema>>,
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
  context: z.core.$RefinementCtx<z.output<typeof finalizedProjectStatsObjectSchema>>,
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
  context: z.core.$RefinementCtx<z.output<typeof finalizedProjectStatsObjectSchema>>,
): void {
  if (
    (stats.analyticsState === "fresh" || stats.analyticsState === "stale") &&
    stats.warehouseVersion === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "fresh or stale analytics must identify its warehouse version",
      path: ["warehouseVersion"],
    });
  }
  if (
    stats.warehouseVersion !== undefined &&
    stats.filter.warehouse_version !== stats.warehouseVersion
  ) {
    context.addIssue({
      code: "custom",
      message: "stats filters must use the response warehouse version",
      path: ["filter", "warehouse_version"],
    });
  }
}

function requireSameFilter(
  context: z.core.$RefinementCtx<z.output<typeof finalizedProjectStatsObjectSchema>>,
  path: Array<string | number>,
  expected: SessionFilter,
  actual: SessionFilter,
): void {
  if (sameFilter(expected, actual)) return;
  context.addIssue({
    code: "custom",
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
