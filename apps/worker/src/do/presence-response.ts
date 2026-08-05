import * as v from "valibot";
import { MAX_LIVE_SESSIONS_PER_PROJECT, MAX_PRESENCE_TEXT_CHARS } from "@orange-replay/shared";
import type { PresenceSession, PresenceSessionHead } from "./presence-logic.ts";

const wholeNumberSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const pathIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
const nullableTextSchema = v.nullable(v.pipe(v.string(), v.maxLength(MAX_PRESENCE_TEXT_CHARS)));
const nullableDimensionSchema = v.nullable(v.pipe(v.string(), v.maxLength(512)));
const presenceSessionSchema = v.object({
  session_id: pathIdSchema,
  org_id: v.optional(v.nullable(pathIdSchema)),
  started_at: wholeNumberSchema,
  last_seen: wholeNumberSchema,
  finalizing_at: v.optional(v.nullable(wholeNumberSchema)),
  entry_url: nullableTextSchema,
  country: nullableDimensionSchema,
  region: v.optional(nullableDimensionSchema),
  city: nullableDimensionSchema,
  browser: nullableDimensionSchema,
  os: nullableDimensionSchema,
  device: nullableDimensionSchema,
  flags: v.optional(wholeNumberSchema),
});
const presenceSessionHeadSchema = v.object({
  ...presenceSessionSchema.entries,
  activity: v.picklist(["live", "idle", "finalizing"]),
});
const presenceListBodySchema = v.object({
  sessions: v.pipe(v.array(presenceSessionSchema), v.maxLength(MAX_LIVE_SESSIONS_PER_PROJECT + 1)),
});
const presenceHeadsBodySchema = v.object({
  sessions: v.pipe(v.array(presenceSessionHeadSchema), v.maxLength(200)),
});
const presenceHeadBodySchema = v.object({ session: v.nullable(presenceSessionHeadSchema) });
const presenceInstallBodySchema = v.object({ firstEventAt: v.nullable(wholeNumberSchema) });
const presenceDebugBodySchema = v.object({
  rows: wholeNumberSchema,
  firstEventAt: v.nullable(wholeNumberSchema),
});

export interface PresenceListBody {
  sessions: PresenceSession[];
}

export interface PresenceHeadsBody {
  sessions: PresenceSessionHead[];
}

export interface PresenceHeadBody {
  session: PresenceSessionHead | null;
}

export interface PresenceInstallBody {
  firstEventAt: number | null;
}

export interface PresenceDebugBody extends PresenceInstallBody {
  rows: number;
}

export function decodePresenceListBody(value: unknown): PresenceListBody {
  return decodePresenceBody(presenceListBodySchema, value, "list");
}

export function decodePresenceHeadsBody(value: unknown): PresenceHeadsBody {
  return decodePresenceBody(presenceHeadsBodySchema, value, "heads");
}

export function decodePresenceHeadBody(value: unknown): PresenceHeadBody {
  return decodePresenceBody(presenceHeadBodySchema, value, "head");
}

export function decodePresenceInstallBody(value: unknown): PresenceInstallBody {
  return decodePresenceBody(presenceInstallBodySchema, value, "install status");
}

export function decodePresenceDebugBody(value: unknown): PresenceDebugBody {
  return decodePresenceBody(presenceDebugBodySchema, value, "debug");
}

function decodePresenceBody<Schema extends v.GenericSchema>(
  schema: Schema,
  value: unknown,
  responseName: string,
): v.InferOutput<Schema> {
  const parsed = v.safeParse(schema, value);
  if (!parsed.success) throw new Error(`Presence ${responseName} response is invalid.`);
  return parsed.output;
}
