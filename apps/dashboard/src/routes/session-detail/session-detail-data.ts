import type { SessionManifest } from "@orange-replay/shared/types";
import {
  ApiError,
  fetchSessionState,
  getManifest,
  type SessionActivity,
  type SessionDetailsState,
  type SessionHead,
} from "../../lib/api";

export type ReplayMode = "recorded" | "live";

export const sessionStatePollIntervalMs = 5_000;

export interface SessionViewQueryResult {
  manifest: SessionManifest | null;
  mode: ReplayMode;
  notFound: boolean;
  activity: SessionActivity | null;
  detailsState: SessionDetailsState | null;
}

export async function loadSessionView(
  projectId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionViewQueryResult> {
  try {
    const state = await fetchSessionState(projectId, sessionId, { signal });
    const manifest =
      state.replay_source === "recorded"
        ? await getManifest(projectId, sessionId, { signal })
        : sessionHeadManifest(state);

    return {
      manifest,
      mode: state.replay_source,
      notFound: false,
      activity: state.activity,
      detailsState: state.details_state,
    };
  } catch (caughtError) {
    if (!isNotFound(caughtError)) throw caughtError;
    return {
      manifest: null,
      mode: "recorded",
      notFound: true,
      activity: null,
      detailsState: null,
    };
  }
}

export function sessionHeadManifest(session: SessionHead): SessionManifest {
  const country = cleanOptionalText(session.country);
  const region = cleanOptionalText(session.region);
  const city = cleanOptionalText(session.city);
  const browser = cleanOptionalText(session.browser);
  const os = cleanOptionalText(session.os);
  const device = cleanOptionalText(session.device);
  const entryUrl = cleanOptionalText(session.entry_url);
  const attrs: SessionManifest["attrs"] = {
    ...(country !== undefined ? { country } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(city !== undefined ? { city } : {}),
    ...(browser !== undefined ? { browser } : {}),
    ...(os !== undefined ? { os } : {}),
    ...(device !== undefined ? { device } : {}),
    ...(entryUrl !== undefined ? { entryUrl } : {}),
  };

  return {
    v: 1,
    sessionId: session.session_id,
    projectId: session.project_id,
    orgId: session.org_id,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    durationMs: Math.max(0, session.duration_ms),
    segments: [],
    timeline: [],
    counts: {
      batches: 0,
      events: 0,
      clicks: 0,
      errors: 0,
      rages: 0,
      navs: 0,
    },
    bytes: 0,
    flags: session.flags,
    attrs,
  };
}

export function shouldPollSessionState(
  detailsState: SessionDetailsState | null | undefined,
  visibilityState: DocumentVisibilityState,
): boolean {
  return detailsState !== "exact" && visibilityState !== "hidden";
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function cleanOptionalText(value: string | null): string | undefined {
  const cleanValue = value?.trim();
  return cleanValue === undefined || cleanValue.length === 0 ? undefined : cleanValue;
}
