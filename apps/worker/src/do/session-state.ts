import type { EdgeAttrs } from "@orange-replay/shared";
import type { AppendArgs } from "./contract.ts";
import {
  normalizePageTabs,
  normalizeSessionAnalyticsVersion,
  updatePageTrackingWithBatch,
  type PageTabState,
} from "./session-page-tracking.ts";

export interface SessionState {
  projectId: string;
  orgId: string;
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
}

const utf8Encoder = new TextEncoder();

export function createFreshState(args: AppendArgs): SessionState {
  return {
    projectId: args.projectId,
    orgId: args.orgId,
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

export function normalizeSessionState(state: SessionState): SessionState {
  return {
    ...state,
    totalEventBytes:
      typeof state.totalEventBytes === "number" && Number.isFinite(state.totalEventBytes)
        ? state.totalEventBytes
        : 0,
    analyticsVersion: normalizeSessionAnalyticsVersion(state.analyticsVersion, state.pageCount),
    pageCount:
      typeof state.pageCount === "number" && Number.isSafeInteger(state.pageCount)
        ? Math.max(0, state.pageCount)
        : 0,
    quickBacks:
      typeof state.quickBacks === "number" && Number.isSafeInteger(state.quickBacks)
        ? Math.max(0, state.quickBacks)
        : 0,
    pageTabs: normalizePageTabs(state.pageTabs),
  };
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
  state.batchCount += 1;
  state.flags = (state.flags | args.flags) >>> 0;

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

export function encodedTextBytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}
