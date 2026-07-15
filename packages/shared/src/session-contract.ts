import { z } from "zod";
import { sessionManifestSchema } from "./schemas.ts";
import { analyticsStateSchema } from "./stats-contract.ts";
import type { SessionManifest } from "./types.ts";

const sessionWholeNumberSchema = z.number().int().safe().nonnegative();
const nullableTextSchema = z.string().nullable();
const activityHistogramSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{2}$/)
  .nullable()
  .default(null);

export const sessionActivitySchema = z.enum(["live", "idle", "finalizing", "complete"]);
export const sessionDetailsStateSchema = z.enum(["provisional", "exact"]);
export const sessionReplaySourceSchema = z.enum(["live", "recorded"]);

export const sessionListItemSchema = z.object({
  session_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
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
  page_count: sessionWholeNumberSchema.nullable(),
  analytics_version: sessionWholeNumberSchema,
  max_scroll_depth: z.number().finite().nullable(),
  quick_backs: sessionWholeNumberSchema.nullable(),
  interaction_time_ms: sessionWholeNumberSchema.nullable(),
  activity_hist: activityHistogramSchema,
  clicks: sessionWholeNumberSchema,
  errors: sessionWholeNumberSchema,
  rages: sessionWholeNumberSchema,
  navs: sessionWholeNumberSchema,
  bytes: sessionWholeNumberSchema,
  segment_count: sessionWholeNumberSchema,
  flags: sessionWholeNumberSchema,
  manifest_key: z.string().min(1),
  expires_at: sessionWholeNumberSchema,
});

export const sessionHeadSchema = sessionListItemSchema
  .extend({
    activity: sessionActivitySchema,
    details_state: sessionDetailsStateSchema,
    replay_source: sessionReplaySourceSchema,
  })
  .superRefine((session, context) => {
    if (
      session.details_state === "exact" &&
      (session.activity !== "complete" || session.replay_source !== "recorded")
    ) {
      context.addIssue({
        code: "custom",
        message: "exact session details must be complete and recorded",
        path: ["details_state"],
      });
    }
    if (
      session.replay_source === "live" &&
      (session.details_state !== "provisional" || session.activity === "finalizing")
    ) {
      context.addIssue({
        code: "custom",
        message: "live replay data must be provisional and not finalizing",
        path: ["replay_source"],
      });
    }
  });

export const listSessionsResponseSchema = z
  .object({
    sessions: z.array(sessionListItemSchema),
    nextBefore: z.string().nullable(),
    warehouseVersion: sessionWholeNumberSchema.optional(),
    analyticsState: analyticsStateSchema.optional(),
  })
  .superRefine((response, context) => {
    if (
      (response.analyticsState === "fresh" || response.analyticsState === "stale") &&
      response.warehouseVersion === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "fresh or stale sessions must identify their warehouse version",
        path: ["warehouseVersion"],
      });
    }
  });

export const listSessionHeadsResponseSchema = z.object({
  sessions: z.array(sessionHeadSchema),
});

export const liveSessionItemSchema = z.object({
  session_id: z.string().min(1),
  started_at: sessionWholeNumberSchema,
  last_seen: sessionWholeNumberSchema,
  entry_url: nullableTextSchema,
  country: nullableTextSchema,
  city: nullableTextSchema,
  browser: nullableTextSchema,
  os: nullableTextSchema,
  device: nullableTextSchema,
  duration_ms: sessionWholeNumberSchema,
});

export const liveSessionsResponseSchema = z.object({
  sessions: z.array(liveSessionItemSchema),
  truncated: z.boolean().default(false),
});

export type SessionActivity = z.output<typeof sessionActivitySchema>;
export type SessionDetailsState = z.output<typeof sessionDetailsStateSchema>;
export type SessionReplaySource = z.output<typeof sessionReplaySourceSchema>;
export type SessionListItem = z.output<typeof sessionListItemSchema>;
export type SessionHead = z.output<typeof sessionHeadSchema>;
export type ListSessionsResponse = z.output<typeof listSessionsResponseSchema>;
export type ListSessionHeadsResponse = z.output<typeof listSessionHeadsResponseSchema>;
export type LiveSessionItem = z.output<typeof liveSessionItemSchema>;
export type LiveSessionsResponse = z.output<typeof liveSessionsResponseSchema>;

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
      pickKnownFields(event, ["t", "k", "d", "m"]),
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
