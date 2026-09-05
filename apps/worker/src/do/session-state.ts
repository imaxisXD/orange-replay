import {
  addDomMaskingBatch,
  domMaskingSchema,
  type DomMasking,
  type EdgeAttrs,
} from "@orange-replay/shared";
import * as v from "valibot";
import type { AppendArgs } from "./contract.ts";
import {
  MAX_TRACKED_PAGE_TABS,
  normalizePageTabs,
  normalizeSessionAnalyticsVersion,
  updatePageTrackingWithBatch,
  type PageTabState,
} from "./session-page-tracking.ts";

export interface SessionState {
  projectId: string;
  orgId: string;
  /** Websites visited during this one Workspace journey. */
  websiteIds?: string[];
  shard: number;
  retentionDays: number;
  sessionId: string;
  startedAt: number;
  lastActivity: number;
  lastFlushAt: number;
  bufferedBytes: number;
  totalPayloadBytes: number;
  totalEventBytes: number;
  batchCount: number;
  segmentCount: number;
  flags: number;
  attrs: EdgeAttrs;
  firstRequestId: string;
  entryUrl?: string;
  urlCount: number;
  analyticsVersion: number;
  pageCount: number;
  quickBacks: number;
  pageTabs: PageTabState[];
  encKeyId?: string;
  lastPresencePingAt?: number;
  checkpointRequested?: boolean;
  finalizingAt?: number;
  domMasking?: DomMasking;
}

const SESSION_STATE_FORMAT = 1;
const pathIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
const nonEmptyTextSchema = v.pipe(v.string(), v.minLength(1));
const wholeNumberSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const finiteNumberSchema = v.pipe(v.number(), v.finite());
const timestampSchema = v.pipe(wholeNumberSchema, v.finite());
const edgeAttrsSchema = v.object({
  country: v.optional(v.string()),
  region: v.optional(v.string()),
  city: v.optional(v.string()),
  device: v.optional(v.string()),
  browser: v.optional(v.string()),
  os: v.optional(v.string()),
  asn: v.optional(wholeNumberSchema),
});
const pageTabSchema = v.object({
  tab: nonEmptyTextSchema,
  url: nonEmptyTextSchema,
  previousUrl: v.optional(nonEmptyTextSchema),
  enteredAt: v.optional(finiteNumberSchema),
});
const websiteIdsSchema = v.pipe(
  v.array(pathIdSchema),
  v.maxLength(100),
  v.check((ids) => new Set(ids).size === ids.length, "Website ids must be unique."),
);
const stableSessionStateEntries = {
  projectId: pathIdSchema,
  orgId: pathIdSchema,
  shard: wholeNumberSchema,
  retentionDays: v.pipe(wholeNumberSchema, v.minValue(1), v.maxValue(365)),
  sessionId: pathIdSchema,
  startedAt: timestampSchema,
  lastActivity: timestampSchema,
  lastFlushAt: timestampSchema,
  bufferedBytes: wholeNumberSchema,
  totalPayloadBytes: wholeNumberSchema,
  batchCount: wholeNumberSchema,
  segmentCount: wholeNumberSchema,
  flags: v.pipe(wholeNumberSchema, v.maxValue(0xffff_ffff)),
  attrs: edgeAttrsSchema,
  firstRequestId: nonEmptyTextSchema,
  entryUrl: v.optional(nonEmptyTextSchema),
  urlCount: wholeNumberSchema,
  encKeyId: v.optional(nonEmptyTextSchema),
  lastPresencePingAt: v.optional(timestampSchema),
  checkpointRequested: v.optional(v.boolean()),
} as const;
const currentSessionStateSchema = v.object({
  ...stableSessionStateEntries,
  websiteIds: v.optional(websiteIdsSchema),
  totalEventBytes: wholeNumberSchema,
  analyticsVersion: wholeNumberSchema,
  pageCount: wholeNumberSchema,
  quickBacks: wholeNumberSchema,
  pageTabs: v.pipe(v.array(pageTabSchema), v.maxLength(MAX_TRACKED_PAGE_TABS)),
  finalizingAt: v.optional(timestampSchema),
  domMasking: v.optional(domMaskingSchema),
});
const storedSessionStateEnvelopeSchema = v.object({
  stateFormat: v.literal(SESSION_STATE_FORMAT),
  state: currentSessionStateSchema,
});
const legacySessionStateSchema = v.object({
  ...stableSessionStateEntries,
  websiteIds: v.optional(v.unknown()),
  totalEventBytes: v.optional(v.unknown()),
  analyticsVersion: v.optional(v.unknown()),
  pageCount: v.optional(v.unknown()),
  quickBacks: v.optional(v.unknown()),
  pageTabs: v.optional(v.unknown()),
  finalizingAt: v.optional(v.unknown()),
  domMasking: v.optional(v.unknown()),
});

type NormalizedSessionStateKey =
  | "domMasking"
  | "websiteIds"
  | "totalEventBytes"
  | "analyticsVersion"
  | "pageCount"
  | "quickBacks"
  | "pageTabs"
  | "finalizingAt";
type NormalizableSessionState = Omit<SessionState, NormalizedSessionStateKey> & {
  [Key in NormalizedSessionStateKey]?: unknown;
};

const utf8Encoder = new TextEncoder();

export function createFreshState(args: AppendArgs): SessionState {
  return {
    projectId: args.projectId,
    orgId: args.orgId,
    ...(args.websiteId === undefined ? {} : { websiteIds: [args.websiteId] }),
    shard: args.shard,
    retentionDays: args.retentionDays,
    sessionId: args.sessionId,
    startedAt: args.receivedAt,
    lastActivity: args.receivedAt,
    lastFlushAt: args.receivedAt,
    bufferedBytes: 0,
    totalPayloadBytes: 0,
    totalEventBytes: 0,
    batchCount: 0,
    segmentCount: 0,
    flags: 0,
    attrs: args.attrs,
    firstRequestId: args.requestId,
    urlCount: 0,
    analyticsVersion: 2,
    pageCount: 0,
    quickBacks: 0,
    pageTabs: [],
  };
}

export function parseStoredSessionState(value: unknown): SessionState {
  if (isRecord(value) && Object.hasOwn(value, "stateFormat")) {
    const parsed = v.safeParse(storedSessionStateEnvelopeSchema, value);
    if (!parsed.success) throw new Error("Stored session state is invalid.");
    return normalizeSessionState(parsed.output.state);
  }

  const legacy = v.safeParse(legacySessionStateSchema, value);
  if (!legacy.success) throw new Error("Stored session state is invalid.");
  return normalizeSessionState(legacy.output);
}

export function encodeStoredSessionState(state: SessionState): string {
  const parsed = v.safeParse(currentSessionStateSchema, state);
  if (!parsed.success) throw new Error("Session state cannot be stored because it is invalid.");
  return JSON.stringify({ stateFormat: SESSION_STATE_FORMAT, state: parsed.output });
}

export function normalizeSessionState(state: NormalizableSessionState): SessionState {
  const {
    websiteIds: rawWebsiteIds,
    totalEventBytes: rawTotalEventBytes,
    analyticsVersion: rawAnalyticsVersion,
    pageCount: rawPageCount,
    quickBacks: rawQuickBacks,
    pageTabs: rawPageTabs,
    finalizingAt: rawFinalizingAt,
    domMasking: rawDomMasking,
    ...stableState
  } = state;
  const websiteIds = normalizeWebsiteIds(rawWebsiteIds);
  const domMasking = domMaskingSchema.safeParse(rawDomMasking);
  const normalized: SessionState = {
    ...stableState,
    ...(websiteIds === undefined ? {} : { websiteIds }),
    totalEventBytes: nonnegativeWholeNumber(rawTotalEventBytes),
    analyticsVersion: normalizeSessionAnalyticsVersion(rawAnalyticsVersion, rawPageCount),
    pageCount: nonnegativeWholeNumber(rawPageCount),
    quickBacks: nonnegativeWholeNumber(rawQuickBacks),
    pageTabs: normalizePageTabs(rawPageTabs),
    ...(domMasking.success ? { domMasking: domMasking.data } : {}),
  };

  if (
    typeof rawFinalizingAt === "number" &&
    Number.isSafeInteger(rawFinalizingAt) &&
    rawFinalizingAt >= 0
  ) {
    normalized.finalizingAt = rawFinalizingAt;
  }

  return normalized;
}

export function updateStateWithBatch(
  state: SessionState,
  args: AppendArgs,
  clampedIndex: AppendArgs["index"],
  eventBytes: number,
): void {
  state.lastActivity = args.receivedAt;
  state.bufferedBytes += args.payload.byteLength;
  state.totalPayloadBytes += args.payload.byteLength;
  state.totalEventBytes += eventBytes;
  state.domMasking = addDomMaskingBatch(
    state.domMasking,
    clampedIndex.appliedDomMasking,
    state.batchCount,
  );
  state.batchCount += 1;
  state.flags = (state.flags | args.flags) >>> 0;
  if (args.websiteId !== undefined && !(state.websiteIds ?? []).includes(args.websiteId)) {
    state.websiteIds = [...(state.websiteIds ?? []), args.websiteId];
  }

  if (clampedIndex.u !== undefined && clampedIndex.u.length > 0) {
    state.entryUrl ??= clampedIndex.u;
    const lastTabUrl = state.pageTabs.find((pageTab) => pageTab.tab === args.tab)?.url;
    if (lastTabUrl !== clampedIndex.u) state.urlCount += 1;
  }
  updatePageTrackingWithBatch(state, args.tab, clampedIndex);

  if (clampedIndex.enc?.k !== undefined) {
    state.encKeyId = clampedIndex.enc.k;
  }
}

function normalizeWebsiteIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = [
    ...new Set(
      value.filter(
        (id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id),
      ),
    ),
  ].slice(0, 100);
  return ids.length === 0 ? undefined : ids;
}

function nonnegativeWholeNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodedTextBytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}
