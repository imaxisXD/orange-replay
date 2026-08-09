import * as v from "valibot";
import {
  MAX_BATCHES_PER_SEGMENT,
  MAX_CHECKPOINTS_PER_BATCH,
  MAX_CHECKPOINTS_PER_SEGMENT,
  MAX_MANIFEST_SEGMENTS,
  MAX_SEQ,
  MAX_SESSION_BATCHES,
} from "./constants.ts";
import type {
  BatchIndex,
  FinalizeMessage,
  IngestAck,
  IndexEvent,
  LiveFinalizedMessage,
  LiveHelloMessage,
  LiveSessionSnapshot,
  LiveTicketResponse,
  ProjectConfig,
  ReplayAssetCaptureMessage,
  StoredProjectConfig,
  SegmentRef,
  SegmentCheckpoint,
  SessionCounts,
  SessionInsights,
  SessionManifest,
} from "./types.ts";
import { schemaCheck, sharedSchema, type SharedSchema } from "./validation.ts";

const indexEventKindSchema = v.picklist([
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
const MAX_LIVE_TICKET_CHARS = 4096;

const finiteNumberSchema = v.pipe(v.number(), v.finite());
const safeIntegerSchema = v.pipe(v.number(), v.safeInteger());
const nonnegativeSafeIntegerSchema = v.pipe(safeIntegerSchema, v.minValue(0));

const eventMetaKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_EVENT_META_KEY_CHARS),
);
const eventMetaValueSchema = v.union([
  v.pipe(v.string(), v.maxLength(MAX_EVENT_META_VALUE_CHARS)),
  finiteNumberSchema,
]);
const eventMetaSchema = v.pipe(
  v.custom<Record<string, string | number>>(isPlainRecord, "event metadata must be an object"),
  v.rawTransform<Record<string, string | number>, Record<string, string | number>>(
    ({ dataset, addIssue }) => {
      const input = dataset.value;
      const output: Record<string, string | number> = {};

      for (const key of Object.keys(input)) {
        const value = input[key];
        const keyResult = v.safeParse(eventMetaKeySchema, key);
        const valueResult = v.safeParse(eventMetaValueSchema, value);
        for (const issue of keyResult.issues ?? []) {
          addIssue({ message: issue.message, path: [eventMetaPath(input, key, "key")] });
        }
        for (const issue of valueResult.issues ?? []) {
          addIssue({ message: issue.message, path: [eventMetaPath(input, key, "value")] });
        }
        if (!keyResult.success || !valueResult.success) continue;

        // Define every key as data so reserved names stay valid metadata
        // without changing the output object's prototype.
        Object.defineProperty(output, keyResult.output, {
          configurable: true,
          enumerable: true,
          value: valueResult.output,
          writable: true,
        });
      }
      return output;
    },
  ),
  v.check(
    (value) => Object.keys(value).length <= MAX_EVENT_META_KEYS,
    `event metadata must have at most ${MAX_EVENT_META_KEYS} keys`,
  ),
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function eventMetaPath(
  input: Record<string, unknown>,
  key: string,
  origin: "key" | "value",
): v.ObjectPathItem {
  return { type: "object", origin, input, key, value: input[key] };
}

const pathIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
const segmentKeySchema = v.pipe(
  v.string(),
  v.maxLength(MAX_R2_KEY_CHARS),
  v.regex(/^p\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/seg-[0-9]{6}\.ors$/),
);
const analyticsSidecarKeySchema = v.pipe(
  v.string(),
  v.maxLength(MAX_R2_KEY_CHARS),
  v.regex(/^p\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/analytics\.ndjson$/),
);
const replayUrlSchema = v.pipe(
  v.string(),
  v.maxLength(MAX_ENTRY_URL_CHARS),
  v.check(isSafeReplayUrl, "entryUrl must be an http(s) URL or a relative path"),
);

const indexEventSchema = v.strictObject({
  t: finiteNumberSchema,
  k: indexEventKindSchema,
  d: v.optional(v.pipe(v.string(), v.maxLength(MAX_EVENT_DETAIL_CHARS))),
  m: v.optional(eventMetaSchema),
}) satisfies v.GenericSchema<IndexEvent, IndexEvent>;

const encSchema = v.strictObject({
  k: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ENC_KEY_CHARS)),
});

const edgeAttrsSchema = v.strictObject({
  country: v.optional(v.string()),
  region: v.optional(v.string()),
  city: v.optional(v.string()),
  device: v.optional(v.string()),
  browser: v.optional(v.string()),
  os: v.optional(v.string()),
  asn: v.optional(nonnegativeSafeIntegerSchema),
});

const sessionAttrsSchema = v.strictObject({
  ...edgeAttrsSchema.entries,
  entryUrl: v.optional(replayUrlSchema),
  urlCount: v.optional(nonnegativeSafeIntegerSchema),
  pageCount: v.optional(nonnegativeSafeIntegerSchema),
}) satisfies v.GenericSchema<SessionManifest["attrs"], SessionManifest["attrs"]>;

const segmentCheckpointSchema = v.strictObject({
  timestamp: finiteNumberSchema,
  tab: pathIdSchema,
  batch: v.pipe(nonnegativeSafeIntegerSchema, v.maxValue(MAX_BATCHES_PER_SEGMENT - 1)),
}) satisfies v.GenericSchema<SegmentCheckpoint, SegmentCheckpoint>;

export const segmentRefSchema: SharedSchema<v.GenericSchema<SegmentRef, SegmentRef>> = sharedSchema(
  v.pipe(
    v.strictObject({
      key: segmentKeySchema,
      bytes: nonnegativeSafeIntegerSchema,
      t0: finiteNumberSchema,
      t1: finiteNumberSchema,
      batches: v.pipe(nonnegativeSafeIntegerSchema, v.maxValue(MAX_BATCHES_PER_SEGMENT)),
      checkpoints: v.optional(
        v.pipe(v.array(segmentCheckpointSchema), v.maxLength(MAX_CHECKPOINTS_PER_SEGMENT)),
      ),
    }),
    schemaCheck<SegmentRef>((segment, context) => {
      if (segment.t0 > segment.t1) {
        context.addIssue({
          message: "segment t0 must be less than or equal to t1",
          path: ["t1"],
        });
      }
      for (const [index, checkpoint] of (segment.checkpoints ?? []).entries()) {
        if (checkpoint.timestamp < segment.t0 || checkpoint.timestamp > segment.t1) {
          context.addIssue({
            message: "checkpoint timestamp must be inside the segment time range",
            path: ["checkpoints", index, "timestamp"],
          });
        }
        if (checkpoint.batch >= segment.batches) {
          context.addIssue({
            message: "checkpoint batch must exist in the segment",
            path: ["checkpoints", index, "batch"],
          });
        }
      }
    }),
  ),
);

const sessionCountsSchema = v.strictObject({
  batches: nonnegativeSafeIntegerSchema,
  events: nonnegativeSafeIntegerSchema,
  clicks: nonnegativeSafeIntegerSchema,
  errors: nonnegativeSafeIntegerSchema,
  rages: nonnegativeSafeIntegerSchema,
  navs: nonnegativeSafeIntegerSchema,
}) satisfies v.GenericSchema<SessionCounts, SessionCounts>;

const liveSessionSnapshotSchema = v.pipe(
  v.strictObject({
    startedAt: finiteNumberSchema,
    endedAt: finiteNumberSchema,
    durationMs: v.pipe(finiteNumberSchema, v.minValue(0)),
    timeline: v.pipe(v.array(indexEventSchema), v.maxLength(MAX_MANIFEST_TIMELINE_EVENTS)),
    counts: sessionCountsSchema,
  }),
  schemaCheck<LiveSessionSnapshot>((snapshot, context) => {
    if (snapshot.startedAt > snapshot.endedAt) {
      context.addIssue({
        message: "live snapshot startedAt must be less than or equal to endedAt",
        path: ["endedAt"],
      });
    }
  }),
) satisfies v.GenericSchema<LiveSessionSnapshot, LiveSessionSnapshot>;

const sessionInsightsSchema = v.strictObject({
  maxScrollDepth: v.pipe(safeIntegerSchema, v.minValue(0), v.maxValue(100)),
  quickBacks: nonnegativeSafeIntegerSchema,
  interactionTimeMs: nonnegativeSafeIntegerSchema,
  activityHist: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{2}$/)))),
}) satisfies v.GenericSchema<SessionInsights, SessionInsights>;

export const maskRuleSchema = sharedSchema(
  v.strictObject({
    selector: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    action: v.picklist(["mask", "block"]),
  }),
);

export const maskRulesSchema = sharedSchema(v.array(maskRuleSchema));

export const captureTogglesSchema = sharedSchema(
  v.strictObject({
    heatmaps: v.boolean(),
    console: v.boolean(),
    network: v.boolean(),
    canvas: v.boolean(),
  }),
);

const projectConfigObject = v.strictObject({
  projectId: pathIdSchema,
  orgId: pathIdSchema,
  shard: nonnegativeSafeIntegerSchema,
  active: v.boolean(),
  sampleRate: v.pipe(finiteNumberSchema, v.minValue(0), v.maxValue(1)),
  // A brand-new hosted project starts fail-closed until its owner adds the
  // website origin. Updates still require at least one explicit origin.
  allowedOrigins: v.array(v.string()),
  maskPolicyVersion: nonnegativeSafeIntegerSchema,
  maskRules: v.optional(maskRulesSchema),
  capture: v.optional(captureTogglesSchema),
  replayAssets: v.optional(v.boolean()),
  quotaState: v.picklist(["ok", "soft", "exceeded"]),
  retentionDays: v.pipe(safeIntegerSchema, v.minValue(1), v.maxValue(365)),
  jurisdiction: v.optional(v.picklist(["eu", "fedramp"])),
  version: v.optional(nonnegativeSafeIntegerSchema),
  sessionCookieDomain: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(253))),
  websiteId: v.optional(pathIdSchema),
  websitePending: v.optional(v.boolean()),
});

export const batchIndexSchema: SharedSchema<v.GenericSchema<BatchIndex, BatchIndex>> = sharedSchema(
  v.pipe(
    v.strictObject({
      v: v.literal(1),
      s: pathIdSchema,
      tab: pathIdSchema,
      seq: v.pipe(safeIntegerSchema, v.minValue(0), v.maxValue(MAX_SEQ)),
      t0: finiteNumberSchema,
      t1: finiteNumberSchema,
      e: v.pipe(v.array(indexEventSchema), v.maxLength(MAX_INDEX_EVENTS_PER_BATCH)),
      checkpointTimestamps: v.optional(
        v.pipe(v.array(finiteNumberSchema), v.maxLength(MAX_CHECKPOINTS_PER_BATCH)),
      ),
      u: v.optional(replayUrlSchema),
      enc: v.optional(encSchema),
    }),
    schemaCheck<BatchIndex>((value, context) => {
      if (value.t0 > value.t1) {
        context.addIssue({
          message: "t0 must be less than or equal to t1",
          path: ["t1"],
        });
      }
      for (const [index, timestamp] of (value.checkpointTimestamps ?? []).entries()) {
        if (timestamp < value.t0 || timestamp > value.t1) {
          context.addIssue({
            message: "checkpoint timestamp must be inside the batch time range",
            path: ["checkpointTimestamps", index],
          });
        }
      }
    }),
  ),
);

export const projectConfigSchema: SharedSchema<v.GenericSchema<ProjectConfig, ProjectConfig>> =
  sharedSchema(projectConfigObject);

export const storedProjectConfigSchema: SharedSchema<
  v.GenericSchema<StoredProjectConfig, StoredProjectConfig>
> = sharedSchema(
  v.object({
    ...projectConfigObject.entries,
    maskRules: maskRulesSchema,
    capture: captureTogglesSchema,
    replayAssets: v.boolean(),
    version: nonnegativeSafeIntegerSchema,
  }),
);

export const sessionManifestSchema: SharedSchema<
  v.GenericSchema<SessionManifest, SessionManifest>
> = sharedSchema(
  v.strictObject({
    v: v.literal(1),
    sessionId: pathIdSchema,
    projectId: pathIdSchema,
    orgId: pathIdSchema,
    websiteIds: v.optional(v.pipe(v.array(pathIdSchema), v.maxLength(100))),
    startedAt: finiteNumberSchema,
    endedAt: finiteNumberSchema,
    durationMs: v.pipe(finiteNumberSchema, v.minValue(0)),
    segments: v.pipe(v.array(segmentRefSchema), v.maxLength(MAX_MANIFEST_SEGMENTS)),
    timeline: v.pipe(v.array(indexEventSchema), v.maxLength(MAX_MANIFEST_TIMELINE_EVENTS)),
    counts: sessionCountsSchema,
    bytes: nonnegativeSafeIntegerSchema,
    flags: nonnegativeSafeIntegerSchema,
    enc: v.optional(encSchema),
    attrs: sessionAttrsSchema,
  }),
);

export const liveTicketResponseSchema: SharedSchema<
  v.GenericSchema<LiveTicketResponse, LiveTicketResponse>
> = sharedSchema(
  v.object({
    ticket: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_LIVE_TICKET_CHARS)),
    expiresAt: v.pipe(safeIntegerSchema, v.minValue(1)),
  }),
);

export const liveHelloMessageSchema: SharedSchema<
  v.GenericSchema<LiveHelloMessage, LiveHelloMessage>
> = sharedSchema(
  v.pipe(
    v.object({
      type: v.literal("hello"),
      sessionId: pathIdSchema,
      startedAt: finiteNumberSchema,
      segments: v.pipe(v.array(segmentRefSchema), v.maxLength(MAX_MANIFEST_SEGMENTS)),
      pendingBatches: v.pipe(nonnegativeSafeIntegerSchema, v.maxValue(MAX_SESSION_BATCHES)),
      snapshot: liveSessionSnapshotSchema,
    }),
    schemaCheck<LiveHelloMessage>((message, context) => {
      if (message.startedAt !== message.snapshot.startedAt) {
        context.addIssue({
          message: "live hello startedAt must match snapshot startedAt",
          path: ["snapshot", "startedAt"],
        });
      }
    }),
  ),
);

export const liveFinalizedMessageSchema: SharedSchema<
  v.GenericSchema<LiveFinalizedMessage, LiveFinalizedMessage>
> = sharedSchema(
  v.object({
    type: v.literal("finalized"),
    manifest: sessionManifestSchema,
  }),
);

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

export const ingestAckSchema: SharedSchema<v.GenericSchema<IngestAck, IngestAck>> = sharedSchema(
  v.strictObject({
    ok: v.boolean(),
    live: v.boolean(),
    flushMs: finiteNumberSchema,
    drop: v.optional(v.boolean()),
    closed: v.optional(v.boolean()),
    checkpoint: v.optional(v.boolean()),
  }),
);

const finalizedAnalyticsEventSchema = v.pipe(
  indexEventSchema,
  v.check((event) => event.k === "error" || event.k === "custom"),
);

export const finalizeMessageSchema: SharedSchema<
  v.GenericSchema<FinalizeMessage, FinalizeMessage>
> = sharedSchema(
  v.pipe(
    v.strictObject({
      type: v.literal("session.finalized"),
      sessionId: pathIdSchema,
      projectId: pathIdSchema,
      orgId: pathIdSchema,
      shard: nonnegativeSafeIntegerSchema,
      requestId: v.string(),
      manifestKey: v.string(),
      analyticsSidecarKey: v.optional(analyticsSidecarKeySchema),
      startedAt: finiteNumberSchema,
      endedAt: finiteNumberSchema,
      // Optional so messages queued by a pre-upgrade DO still parse during a
      // deploy window; the consumer falls back to the server-time span.
      durationMs: v.optional(v.pipe(finiteNumberSchema, v.minValue(0))),
      hasCheckpoint: v.optional(v.boolean()),
      bytes: nonnegativeSafeIntegerSchema,
      segments: nonnegativeSafeIntegerSchema,
      flags: nonnegativeSafeIntegerSchema,
      analyticsVersion: v.optional(nonnegativeSafeIntegerSchema),
      insights: v.optional(sessionInsightsSchema),
      counts: sessionCountsSchema,
      attrs: sessionAttrsSchema,
      retentionDays: nonnegativeSafeIntegerSchema,
      events: v.pipe(v.array(finalizedAnalyticsEventSchema), v.maxLength(200)),
    }),
    schemaCheck<FinalizeMessage>((message, context) => {
      if (message.analyticsVersion !== undefined && message.analyticsVersion >= 1) {
        if (message.attrs.pageCount === undefined) {
          context.addIssue({
            message: "pageCount is required for covered analytics",
            path: ["attrs", "pageCount"],
          });
        }
      }
      if (message.analyticsVersion !== undefined && message.analyticsVersion >= 2) {
        if (message.insights === undefined) {
          context.addIssue({
            message: "insights are required for covered derived analytics",
            path: ["insights"],
          });
        }
      }
    }),
  ),
);

export const replayAssetCaptureMessageSchema: SharedSchema<
  v.GenericSchema<ReplayAssetCaptureMessage, ReplayAssetCaptureMessage>
> = sharedSchema(
  v.strictObject({
    type: v.literal("session.replay-assets"),
    sessionId: pathIdSchema,
    projectId: pathIdSchema,
    shard: nonnegativeSafeIntegerSchema,
    requestId: v.string(),
    manifestKey: v.string(),
    endedAt: finiteNumberSchema,
    retentionDays: nonnegativeSafeIntegerSchema,
  }),
);
