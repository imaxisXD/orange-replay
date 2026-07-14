import { encodeSessionFilter, type SessionFilter } from "@orange-replay/shared";
import type { SessionManifest } from "@orange-replay/shared/types";
import { encodePathPart, requestJson } from "./client";

export interface SessionListItem {
  session_id: string;
  project_id: string;
  org_id: string;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  entry_url: string | null;
  url_count: number;
  page_count: number | null;
  analytics_version: number;
  max_scroll_depth: number | null;
  quick_backs: number | null;
  interaction_time_ms: number | null;
  /** 8-bucket activity histogram (F5); absent until the worker column ships. */
  activity_hist?: string | null;
  clicks: number;
  errors: number;
  rages: number;
  navs: number;
  bytes: number;
  segment_count: number;
  flags: number;
  manifest_key: string;
  expires_at: number;
}

export type SessionActivity = "live" | "idle" | "finalizing" | "complete";
export type SessionDetailsState = "provisional" | "exact";
export type SessionReplaySource = "live" | "recorded";

/**
 * A fast control-plane row. Provisional rows use placeholder zeroes for exact
 * analytics fields, so callers must check `details_state` before showing them.
 */
export interface SessionHead extends SessionListItem {
  activity: SessionActivity;
  details_state: SessionDetailsState;
  replay_source: SessionReplaySource;
}

export type ListSessionsParams = SessionFilter & {
  before?: string | null;
  limit?: number;
  sort?: "newest" | "friction" | "duration" | "clicks" | "pages";
};

export interface ListSessionsResponse {
  sessions: SessionListItem[];
  nextBefore: string | null;
  warehouseVersion?: number;
  analyticsState?: "fresh" | "stale" | "compare" | "d1_rollback" | "d1_residency";
}

export type ListSessionHeadsParams = Omit<ListSessionsParams, "before"> & {
  opened_at: number;
  warehouse_to?: number;
  tracked_session_id?: readonly string[];
};

export interface ListSessionHeadsResponse {
  sessions: SessionHead[];
}

export interface LiveSessionItem {
  session_id: string;
  started_at: number;
  last_seen: number;
  entry_url: string | null;
  country: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  duration_ms: number;
}

export interface LiveSessionsResponse {
  sessions: LiveSessionItem[];
}

export async function listSessions(
  projectId: string,
  params: ListSessionsParams = {},
  options: { signal?: AbortSignal } = {},
): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>(buildSessionListUrl(projectId, params), {
    auth: true,
    signal: options.signal,
  });
}

export async function fetchSessionHeads(
  projectId: string,
  params: ListSessionHeadsParams,
  options: { signal?: AbortSignal } = {},
): Promise<ListSessionHeadsResponse> {
  return requestJson<ListSessionHeadsResponse>(buildSessionHeadsUrl(projectId, params), {
    auth: true,
    signal: options.signal,
  });
}

export async function fetchSessionState(
  projectId: string,
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionHead> {
  const path = `/api/v1/projects/${encodePathPart(projectId)}/sessions/${encodePathPart(
    sessionId,
  )}/state`;
  return requestJson<SessionHead>(path, { auth: true, signal: options.signal });
}

export async function fetchLiveSessions(
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<LiveSessionsResponse> {
  return requestJson<LiveSessionsResponse>(`/api/v1/projects/${encodePathPart(projectId)}/live`, {
    auth: true,
    signal: options.signal,
  });
}

export async function getManifest(
  projectId: string,
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionManifest> {
  const path = `/api/v1/projects/${encodePathPart(projectId)}/sessions/${encodePathPart(
    sessionId,
  )}/manifest`;
  return requestJson<SessionManifest>(path, { auth: true, signal: options.signal });
}

export function segmentUrl(projectId: string, sessionId: string, name: string): string {
  return `/api/v1/projects/${encodePathPart(projectId)}/sessions/${encodePathPart(
    sessionId,
  )}/segments/${encodePathPart(name)}`;
}

export function buildSessionListUrl(projectId: string, params: ListSessionsParams = {}): string {
  return buildSessionSearchUrl(projectId, "sessions", params);
}

export function buildSessionHeadsUrl(projectId: string, params: ListSessionHeadsParams): string {
  return buildSessionSearchUrl(projectId, "session-heads", params);
}

function buildSessionSearchUrl(
  projectId: string,
  route: "sessions" | "session-heads",
  params: ListSessionsParams | ListSessionHeadsParams,
): string {
  const query = new URLSearchParams();

  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if ("before" in params && params.before) query.set("before", params.before);
  if (params.sort !== undefined && params.sort !== "newest") query.set("sort", params.sort);
  if (route === "session-heads") {
    const headParams = params as ListSessionHeadsParams;
    query.set("opened_at", String(headParams.opened_at));
    if (headParams.warehouse_to !== undefined) {
      query.set("warehouse_to", String(headParams.warehouse_to));
    }
    for (const sessionId of headParams.tracked_session_id ?? []) {
      query.append("tracked_session_id", sessionId);
    }
  }
  const sessionFilter = sessionFilterFromParams(params);
  const filter = encodeSessionFilter(sessionFilter);
  for (const [key, value] of filter) {
    query.set(key, value);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `/api/v1/projects/${encodePathPart(projectId)}/${route}${suffix}`;
}

function sessionFilterFromParams(
  params: ListSessionsParams | ListSessionHeadsParams,
): SessionFilter {
  const { limit: _limit, sort: _sort, ...withPossibleBeforeAndControls } = params;
  const withPossibleBefore =
    "opened_at" in withPossibleBeforeAndControls
      ? withoutSessionHeadControls(withPossibleBeforeAndControls)
      : withPossibleBeforeAndControls;
  if ("before" in withPossibleBefore) {
    const { before: _before, ...sessionFilter } = withPossibleBefore;
    return sessionFilter;
  }
  return withPossibleBefore;
}

function withoutSessionHeadControls(
  params: Omit<ListSessionHeadsParams, "limit" | "sort">,
): SessionFilter {
  const {
    opened_at: _openedAt,
    warehouse_to: _warehouseTo,
    tracked_session_id: _trackedSessionIds,
    ...sessionFilter
  } = params;
  return sessionFilter;
}
