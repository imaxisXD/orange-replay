import { z } from "zod";
import { MAX_SEQ } from "./constants.ts";
import type {
  BatchIndex,
  FinalizeMessage,
  IngestAck,
  IndexEvent,
  ProjectConfigUpdate,
  ProjectConfig,
  StoredProjectConfig,
  SegmentRef,
  SessionCounts,
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

const eventMetaSchema = z.record(z.string(), z.union([z.string(), z.number()]));

const indexEventSchema: z.ZodType<IndexEvent> = z
  .object({
    t: z.number(),
    k: indexEventKindSchema,
    d: z.string().optional(),
    m: eventMetaSchema.optional(),
  })
  .strict();

const encSchema = z
  .object({
    k: z.string(),
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
    entryUrl: z.string().optional(),
    urlCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const segmentRefSchema: z.ZodType<SegmentRef> = z
  .object({
    key: z.string(),
    bytes: z.number().int().nonnegative(),
    t0: z.number(),
    t1: z.number(),
    batches: z.number().int().nonnegative(),
  })
  .strict();

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
    projectId: z.string(),
    orgId: z.string(),
    shard: z.number().int().nonnegative(),
    active: z.boolean(),
    sampleRate: z.number().min(0).max(1),
    allowedOrigins: z.array(z.string()),
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
    s: z.string(),
    tab: z.string(),
    seq: z.number().int().min(0).max(MAX_SEQ),
    t0: z.number(),
    t1: z.number(),
    e: z.array(indexEventSchema),
    u: z.string().optional(),
    enc: encSchema.optional(),
  })
  .strict()
  .refine((value) => value.t0 <= value.t1, {
    message: "t0 must be less than or equal to t1",
    path: ["t1"],
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
    sampleRate: z.number().min(0).max(1),
    retentionDays: z.number().int().min(1).max(365),
    allowedOrigins: z.array(z.string().min(1).max(500)).max(100),
    maskPolicyVersion: z.number().int().nonnegative(),
    maskRules: maskRulesSchema.max(200),
    capture: captureTogglesSchema,
    quotaState: z.enum(["ok", "soft", "exceeded"]),
    jurisdiction: z.enum(["eu", "fedramp"]).nullable().optional(),
  })
  .strict();

export const sessionManifestSchema: z.ZodType<SessionManifest> = z
  .object({
    v: z.literal(1),
    sessionId: z.string(),
    projectId: z.string(),
    orgId: z.string(),
    startedAt: z.number(),
    endedAt: z.number(),
    durationMs: z.number().nonnegative(),
    segments: z.array(segmentRefSchema),
    timeline: z.array(indexEventSchema),
    counts: sessionCountsSchema,
    bytes: z.number().int().nonnegative(),
    flags: z.number().int().nonnegative(),
    enc: encSchema.optional(),
    attrs: sessionAttrsSchema,
  })
  .strict();

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
    sessionId: z.string(),
    projectId: z.string(),
    orgId: z.string(),
    shard: z.number().int().nonnegative(),
    requestId: z.string(),
    manifestKey: z.string(),
    startedAt: z.number(),
    endedAt: z.number(),
    bytes: z.number().int().nonnegative(),
    segments: z.number().int().nonnegative(),
    flags: z.number().int().nonnegative(),
    counts: sessionCountsSchema,
    attrs: sessionAttrsSchema,
    retentionDays: z.number().int().nonnegative(),
    events: z
      .array(indexEventSchema.refine((event) => event.k === "error" || event.k === "custom"))
      .max(200),
  })
  .strict();
