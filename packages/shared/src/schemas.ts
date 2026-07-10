import { z } from "zod";
import {
  MAX_BATCHES_PER_SEGMENT,
  MAX_CHECKPOINTS_PER_BATCH,
  MAX_CHECKPOINTS_PER_SEGMENT,
  MAX_MANIFEST_SEGMENTS,
  MAX_SEQ,
} from "./constants.ts";
import type {
  BatchIndex,
  FinalizeMessage,
  IngestAck,
  IndexEvent,
  ProjectConfigUpdate,
  ProjectConfig,
  StoredProjectConfig,
  SegmentRef,
  SegmentCheckpoint,
  SessionCounts,
  SessionInsights,
  SessionManifest,
} from "./types.ts";

const indexEventKindSchema = z.enum([
  "click",
  "rage",
  "error",
  "nav",
  "custom",
  "input",
  "scroll",
  "vital",
]);

const MAX_EVENT_DETAIL_CHARS = 200;
const MAX_EVENT_META_KEYS = 16;
const MAX_EVENT_META_KEY_CHARS = 200;
const MAX_EVENT_META_VALUE_CHARS = 200;
const MAX_INDEX_EVENTS_PER_BATCH = 200;
const MAX_MANIFEST_TIMELINE_EVENTS = 10_000;
const MAX_R2_KEY_CHARS = 512;
const MAX_ENTRY_URL_CHARS = 2048;
const MAX_ENC_KEY_CHARS = 64;

const eventMetaSchema = z
  .record(
    z.string().min(1).max(MAX_EVENT_META_KEY_CHARS),
    z.union([z.string().max(MAX_EVENT_META_VALUE_CHARS), z.number()]),
  )
  .refine((value) => Object.keys(value).length <= MAX_EVENT_META_KEYS, {
    message: `event metadata must have at most ${MAX_EVENT_META_KEYS} keys`,
  });
const pathIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const segmentKeySchema = z
  .string()
  .max(MAX_R2_KEY_CHARS)
  .regex(/^p\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/seg-[0-9]{6}\.ors$/);
const replayUrlSchema = z.string().max(MAX_ENTRY_URL_CHARS).refine(isSafeReplayUrl, {
  message: "entryUrl must be an http(s) URL or a relative path",
});

const indexEventSchema: z.ZodType<IndexEvent> = z
  .object({
    t: z.number(),
    k: indexEventKindSchema,
    d: z.string().max(MAX_EVENT_DETAIL_CHARS).optional(),
    m: eventMetaSchema.optional(),
  })
  .strict();

const encSchema = z
  .object({
    k: z.string().min(1).max(MAX_ENC_KEY_CHARS),
  })
  .strict();

const edgeAttrsSchema = z
  .object({
    country: z.string().optional(),
    region: z.string().optional(),
    city: z.string().optional(),
    device: z.string().optional(),
    browser: z.string().optional(),
    os: z.string().optional(),
    asn: z.number().int().nonnegative().optional(),
  })
  .strict();

const sessionAttrsSchema: z.ZodType<SessionManifest["attrs"]> = edgeAttrsSchema
  .extend({
    entryUrl: replayUrlSchema.optional(),
    urlCount: z.number().int().nonnegative().optional(),
    pageCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const segmentCheckpointSchema: z.ZodType<SegmentCheckpoint> = z
  .object({
    timestamp: z.number(),
    tab: pathIdSchema,
    batch: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_BATCHES_PER_SEGMENT - 1),
  })
  .strict();

const segmentRefSchema: z.ZodType<SegmentRef> = z
  .object({
    key: segmentKeySchema,
    bytes: z.number().int().nonnegative(),
    t0: z.number(),
    t1: z.number(),
    batches: z.number().int().nonnegative().max(MAX_BATCHES_PER_SEGMENT),
    checkpoints: z.array(segmentCheckpointSchema).max(MAX_CHECKPOINTS_PER_SEGMENT).optional(),
  })
  .strict()
  .superRefine((segment, context) => {
    for (const [index, checkpoint] of (segment.checkpoints ?? []).entries()) {
      if (checkpoint.timestamp < segment.t0 || checkpoint.timestamp > segment.t1) {
        context.addIssue({
          code: "custom",
          message: "checkpoint timestamp must be inside the segment time range",
          path: ["checkpoints", index, "timestamp"],
        });
      }
      if (checkpoint.batch >= segment.batches) {
        context.addIssue({
          code: "custom",
          message: "checkpoint batch must exist in the segment",
          path: ["checkpoints", index, "batch"],
        });
      }
    }
  });

const sessionCountsSchema: z.ZodType<SessionCounts> = z
  .object({
    batches: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    clicks: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    rages: z.number().int().nonnegative(),
    navs: z.number().int().nonnegative(),
  })
  .strict();

const sessionInsightsSchema: z.ZodType<SessionInsights> = z
  .object({
    maxScrollDepth: z.number().int().min(0).max(100),
    quickBacks: z.number().int().nonnegative(),
    interactionTimeMs: z.number().int().nonnegative(),
    activityHist: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{2}$/)
      .nullable()
      .optional(),
  })
  .strict();

export const maskRuleSchema = z
  .object({
    selector: z.string().min(1).max(500),
    action: z.enum(["mask", "block"]),
  })
  .strict();

export const maskRulesSchema = z.array(maskRuleSchema);

export const captureTogglesSchema = z
  .object({
    heatmaps: z.boolean(),
    console: z.boolean(),
    network: z.boolean(),
    canvas: z.boolean(),
  })
  .strict();

const projectConfigObject = z
  .object({
    projectId: pathIdSchema,
    orgId: pathIdSchema,
    shard: z.number().int().nonnegative(),
    active: z.boolean(),
    sampleRate: z.number().min(0).max(1),
    allowedOrigins: z.array(z.string()).min(1),
    maskPolicyVersion: z.number().int().nonnegative(),
    maskRules: maskRulesSchema.optional(),
    capture: captureTogglesSchema.optional(),
    quotaState: z.enum(["ok", "soft", "exceeded"]),
    retentionDays: z.number().int().min(1).max(365),
    jurisdiction: z.enum(["eu", "fedramp"]).optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .strict();

export const batchIndexSchema: z.ZodType<BatchIndex> = z
  .object({
    v: z.literal(1),
    s: pathIdSchema,
    tab: pathIdSchema,
    seq: z.number().int().min(0).max(MAX_SEQ),
    t0: z.number(),
    t1: z.number(),
    e: z.array(indexEventSchema).max(MAX_INDEX_EVENTS_PER_BATCH),
    checkpointTimestamps: z.array(z.number()).max(MAX_CHECKPOINTS_PER_BATCH).optional(),
    u: replayUrlSchema.optional(),
    enc: encSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.t0 > value.t1) {
      context.addIssue({
        code: "custom",
        message: "t0 must be less than or equal to t1",
        path: ["t1"],
      });
    }
    for (const [index, timestamp] of (value.checkpointTimestamps ?? []).entries()) {
      if (timestamp < value.t0 || timestamp > value.t1) {
        context.addIssue({
          code: "custom",
          message: "checkpoint timestamp must be inside the batch time range",
          path: ["checkpointTimestamps", index],
        });
      }
    }
  });

export const projectConfigSchema: z.ZodType<ProjectConfig> = projectConfigObject;

export const storedProjectConfigSchema: z.ZodType<StoredProjectConfig> = projectConfigObject
  .extend({
    maskRules: maskRulesSchema,
    capture: captureTogglesSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export const projectConfigUpdateSchema: z.ZodType<ProjectConfigUpdate> = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    sampleRate: z.number().min(0).max(1),
    retentionDays: z.number().int().min(1).max(365),
    allowedOrigins: z.array(z.string().min(1).max(500)).min(1).max(100),
    maskPolicyVersion: z.number().int().nonnegative(),
    maskRules: maskRulesSchema.max(200),
    capture: captureTogglesSchema,
  })
  .strict();

export const sessionManifestSchema: z.ZodType<SessionManifest> = z
  .object({
    v: z.literal(1),
    sessionId: pathIdSchema,
    projectId: pathIdSchema,
    orgId: pathIdSchema,
    startedAt: z.number(),
    endedAt: z.number(),
    durationMs: z.number().nonnegative(),
    segments: z.array(segmentRefSchema).max(MAX_MANIFEST_SEGMENTS),
    timeline: z.array(indexEventSchema).max(MAX_MANIFEST_TIMELINE_EVENTS),
    counts: sessionCountsSchema,
    bytes: z.number().int().nonnegative(),
    flags: z.number().int().nonnegative(),
    enc: encSchema.optional(),
    attrs: sessionAttrsSchema,
  })
  .strict();

function isSafeReplayUrl(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) {
    try {
      const parsed = new URL(value, "https://orange-replay.invalid");
      return parsed.protocol === "https:" && parsed.pathname.startsWith("/");
    } catch {
      return false;
    }
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const ingestAckSchema: z.ZodType<IngestAck> = z
  .object({
    ok: z.boolean(),
    live: z.boolean(),
    flushMs: z.number(),
    drop: z.boolean().optional(),
    closed: z.boolean().optional(),
    checkpoint: z.boolean().optional(),
  })
  .strict();

export const finalizeMessageSchema: z.ZodType<FinalizeMessage> = z
  .object({
    type: z.literal("session.finalized"),
    sessionId: pathIdSchema,
    projectId: pathIdSchema,
    orgId: pathIdSchema,
    shard: z.number().int().nonnegative(),
    requestId: z.string(),
    manifestKey: z.string(),
    startedAt: z.number(),
    endedAt: z.number(),
    bytes: z.number().int().nonnegative(),
    segments: z.number().int().nonnegative(),
    flags: z.number().int().nonnegative(),
    analyticsVersion: z.number().int().nonnegative().optional(),
    insights: sessionInsightsSchema.optional(),
    counts: sessionCountsSchema,
    attrs: sessionAttrsSchema,
    retentionDays: z.number().int().nonnegative(),
    events: z
      .array(indexEventSchema.refine((event) => event.k === "error" || event.k === "custom"))
      .max(200),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.analyticsVersion !== undefined && message.analyticsVersion >= 1) {
      if (message.attrs.pageCount === undefined) {
        context.addIssue({
          code: "custom",
          message: "pageCount is required for covered analytics",
          path: ["attrs", "pageCount"],
        });
      }
    }
    if (message.analyticsVersion !== undefined && message.analyticsVersion >= 2) {
      if (message.insights === undefined) {
        context.addIssue({
          code: "custom",
          message: "insights are required for covered derived analytics",
          path: ["insights"],
        });
      }
    }
  });
