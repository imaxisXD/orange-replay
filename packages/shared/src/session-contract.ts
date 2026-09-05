import * as v from "valibot";
import { sessionManifestSchema } from "./schemas.ts";
import {
  analyticsDeliverySchema,
  analyticsStateSchema,
  analyticsViewSchema,
} from "./stats-contract.ts";
import type { SessionManifest } from "./types.ts";
import { schemaCheck, sharedSchema } from "./validation.ts";

const sessionWholeNumberSchema = v.pipe(v.number(), v.integer(), v.safeInteger(), v.minValue(0));
const nullableTextSchema = v.nullable(v.string());
const activityHistogramSchema = v.optional(
  v.nullable(v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{2}$/))),
  null,
);

export const sessionActivitySchema = sharedSchema(
  v.picklist(["live", "idle", "finalizing", "complete"]),
);
export const sessionDetailsStateSchema = sharedSchema(v.picklist(["provisional", "exact"]));
export const sessionReplaySourceSchema = sharedSchema(v.picklist(["live", "recorded"]));

const sessionListItemEntries = {
  session_id: v.pipe(v.string(), v.minLength(1)),
  project_id: v.pipe(v.string(), v.minLength(1)),
  org_id: v.pipe(v.string(), v.minLength(1)),
  started_at: sessionWholeNumberSchema,
  ended_at: sessionWholeNumberSchema,
  duration_ms: sessionWholeNumberSchema,
  country: nullableTextSchema,
  region: nullableTextSchema,
  city: nullableTextSchema,
  device: nullableTextSchema,
  browser: nullableTextSchema,
  os: nullableTextSchema,
  entry_url: nullableTextSchema,
  url_count: sessionWholeNumberSchema,
  page_count: v.nullable(sessionWholeNumberSchema),
  analytics_version: sessionWholeNumberSchema,
  max_scroll_depth: v.nullable(v.pipe(v.number(), v.finite())),
  quick_backs: v.nullable(sessionWholeNumberSchema),
  interaction_time_ms: v.nullable(sessionWholeNumberSchema),
  activity_hist: activityHistogramSchema,
  clicks: sessionWholeNumberSchema,
  errors: sessionWholeNumberSchema,
  rages: sessionWholeNumberSchema,
  navs: sessionWholeNumberSchema,
  bytes: sessionWholeNumberSchema,
  segment_count: sessionWholeNumberSchema,
  flags: sessionWholeNumberSchema,
  manifest_key: v.pipe(v.string(), v.minLength(1)),
  expires_at: sessionWholeNumberSchema,
  // Defaulted so responses from older workers decode to "unknown" instead of
  // failing; false means the recording has no full-snapshot checkpoint and
  // therefore nothing to replay.
  has_checkpoint: v.optional(v.nullable(v.boolean()), null),
} as const;

export const sessionListItemSchema = sharedSchema(v.object(sessionListItemEntries));

const sessionHeadBaseSchema = v.object({
  ...sessionListItemEntries,
  activity: sessionActivitySchema,
  details_state: sessionDetailsStateSchema,
  replay_source: sessionReplaySourceSchema,
});
export const sessionHeadSchema = sharedSchema(
  v.pipe(
    sessionHeadBaseSchema,
    schemaCheck<v.InferOutput<typeof sessionHeadBaseSchema>>((session, context) => {
      if (
        session.details_state === "exact" &&
        (session.activity !== "complete" || session.replay_source !== "recorded")
      ) {
        context.addIssue({
          message: "exact session details must be complete and recorded",
          path: ["details_state"],
        });
      }
      if (
        session.replay_source === "live" &&
        (session.details_state !== "provisional" || session.activity === "finalizing")
      ) {
        context.addIssue({
          message: "live replay data must be provisional and not finalizing",
          path: ["replay_source"],
        });
      }
    }),
  ),
);

const listSessionsResponseBaseSchema = v.object({
  sessions: v.array(sessionListItemSchema),
  nextBefore: v.nullable(v.string()),
  warehouseVersion: v.optional(sessionWholeNumberSchema),
  analyticsState: v.optional(analyticsStateSchema),
  analyticsDelivery: v.optional(analyticsDeliverySchema),
  analyticsView: v.optional(analyticsViewSchema),
});
export const listSessionsResponseSchema = sharedSchema(
  v.pipe(
    listSessionsResponseBaseSchema,
    schemaCheck<v.InferOutput<typeof listSessionsResponseBaseSchema>>((response, context) => {
      if (
        (response.analyticsState === "fresh" || response.analyticsState === "stale") &&
        response.warehouseVersion === undefined
      ) {
        context.addIssue({
          message: "fresh or stale sessions must identify their warehouse version",
          path: ["warehouseVersion"],
        });
      }
    }),
  ),
);

export const listSessionHeadsResponseSchema = sharedSchema(
  v.object({
    sessions: v.array(sessionHeadSchema),
  }),
);

export const liveSessionItemSchema = sharedSchema(
  v.object({
    session_id: v.pipe(v.string(), v.minLength(1)),
    started_at: sessionWholeNumberSchema,
    last_seen: sessionWholeNumberSchema,
    entry_url: nullableTextSchema,
    country: nullableTextSchema,
    city: nullableTextSchema,
    browser: nullableTextSchema,
    os: nullableTextSchema,
    device: nullableTextSchema,
    duration_ms: sessionWholeNumberSchema,
  }),
);

export const liveSessionsResponseSchema = sharedSchema(
  v.object({
    sessions: v.array(liveSessionItemSchema),
    truncated: v.optional(v.boolean(), false),
  }),
);

export type SessionActivity = v.InferOutput<typeof sessionActivitySchema>;
export type SessionDetailsState = v.InferOutput<typeof sessionDetailsStateSchema>;
export type SessionReplaySource = v.InferOutput<typeof sessionReplaySourceSchema>;
export type SessionListItem = v.InferOutput<typeof sessionListItemSchema>;
export type SessionHead = v.InferOutput<typeof sessionHeadSchema>;
export type ListSessionsResponse = v.InferOutput<typeof listSessionsResponseSchema>;
export type ListSessionHeadsResponse = v.InferOutput<typeof listSessionHeadsResponseSchema>;
export type LiveSessionItem = v.InferOutput<typeof liveSessionItemSchema>;
export type LiveSessionsResponse = v.InferOutput<typeof liveSessionsResponseSchema>;

export function decodeListSessionsResponse(value: unknown): ListSessionsResponse {
  return listSessionsResponseSchema.parse(value);
}

export function decodeListSessionHeadsResponse(value: unknown): ListSessionHeadsResponse {
  return listSessionHeadsResponseSchema.parse(value);
}

export function decodeSessionHead(value: unknown): SessionHead {
  return sessionHeadSchema.parse(value);
}

export function decodeLiveSessionsResponse(value: unknown): LiveSessionsResponse {
  return liveSessionsResponseSchema.parse(value);
}

export function decodeSessionManifestResponse(value: unknown): SessionManifest {
  return sessionManifestSchema.parse(stripUnknownManifestFields(value));
}

function stripUnknownManifestFields(value: unknown): unknown {
  const manifest = pickKnownFields(value, [
    "v",
    "sessionId",
    "projectId",
    "orgId",
    "startedAt",
    "endedAt",
    "durationMs",
    "segments",
    "timeline",
    "counts",
    "bytes",
    "flags",
    "domMasking",
    "domMaskingSummary",
    "enc",
    "attrs",
  ]);
  if (!isRecord(manifest)) return manifest;

  if (Array.isArray(manifest["segments"])) {
    manifest["segments"] = manifest["segments"].map((segment) =>
      stripUnknownSegmentFields(segment),
    );
  }
  if (Array.isArray(manifest["timeline"])) {
    manifest["timeline"] = manifest["timeline"].map((event) =>
      pickKnownFields(event, ["t", "k", "tab", "d", "m"]),
    );
  }
  manifest["counts"] = pickKnownFields(manifest["counts"], [
    "batches",
    "events",
    "clicks",
    "errors",
    "rages",
    "navs",
  ]);
  manifest["enc"] = pickKnownFields(manifest["enc"], ["k"]);
  manifest["attrs"] = pickKnownFields(manifest["attrs"], [
    "country",
    "region",
    "city",
    "device",
    "browser",
    "os",
    "asn",
    "entryUrl",
    "urlCount",
    "pageCount",
  ]);
  return manifest;
}

function stripUnknownSegmentFields(value: unknown): unknown {
  const segment = pickKnownFields(value, ["key", "bytes", "t0", "t1", "batches", "checkpoints"]);
  if (!isRecord(segment)) return segment;
  if (Array.isArray(segment["checkpoints"])) {
    segment["checkpoints"] = segment["checkpoints"].map((checkpoint) =>
      pickKnownFields(checkpoint, ["timestamp", "tab", "batch"]),
    );
  }
  return segment;
}

function pickKnownFields(value: unknown, keys: readonly string[]): unknown {
  if (!isRecord(value)) return value;

  const known: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in value) known[key] = value[key];
  }
  return known;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
