import {
  decodeListSessionHeadsResponse,
  decodeListSessionsResponse,
  decodeLiveSessionsResponse,
  decodeSessionHead,
  decodeSessionManifestResponse,
  encodeSessionFilter,
  type ListSessionHeadsResponse,
  type ListSessionsResponse,
  type LiveSessionsResponse,
  type SessionFilter,
  type SessionHead,
  type SessionManifest,
} from "@orange-replay/shared";
import { encodePathPart, requestJson } from "./client";

export type {
  ListSessionHeadsResponse,
  ListSessionsResponse,
  LiveSessionItem,
  LiveSessionsResponse,
  SessionActivity,
  SessionDetailsState,
  SessionHead,
  SessionListItem,
  SessionReplaySource,
} from "@orange-replay/shared";

export type ListSessionsParams = SessionFilter & {
  before?: string | null;
  limit?: number;
  sort?: "newest" | "friction" | "duration" | "clicks" | "pages";
};

export type ListSessionHeadsParams = Omit<ListSessionsParams, "before"> & {
  opened_at: number;
  warehouse_to?: number;
  tracked_session_id?: readonly string[];
};

export async function listSessions(
  projectId: string,
  params: ListSessionsParams = {},
  options: { signal?: AbortSignal } = {},
): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>(buildSessionListUrl(projectId, params), {
    auth: true,
    decode: decodeListSessionsResponse,
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
    decode: decodeListSessionHeadsResponse,
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
  return requestJson<SessionHead>(path, {
    auth: true,
    decode: decodeSessionHead,
    signal: options.signal,
  });
}

export async function fetchLiveSessions(
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<LiveSessionsResponse> {
  return requestJson<LiveSessionsResponse>(`/api/v1/projects/${encodePathPart(projectId)}/live`, {
    auth: true,
    decode: decodeLiveSessionsResponse,
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
  return requestJson<SessionManifest>(path, {
    auth: true,
    decode: decodeSessionManifestResponse,
    signal: options.signal,
  });
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
