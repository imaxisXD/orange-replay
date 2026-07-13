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
  const query = new URLSearchParams();

  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.before) query.set("before", params.before);
  if (params.sort !== undefined && params.sort !== "newest") query.set("sort", params.sort);
  const { before: _before, limit: _limit, sort: _sort, ...sessionFilter } = params;
  const filter = encodeSessionFilter(sessionFilter);
  for (const [key, value] of filter) {
    query.set(key, value);
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `/api/v1/projects/${encodePathPart(projectId)}/sessions${suffix}`;
}
