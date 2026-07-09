import type { SessionManifest } from "@orange-replay/shared/types";
import { ApiError, fetchLiveSessions, getManifest, type LiveSessionItem } from "@/lib/api";

export type ReplayMode = "recorded" | "live";

export interface ManifestQueryResult {
  manifest: SessionManifest | null;
  mode: ReplayMode;
  notFound: boolean;
}

export async function loadSessionManifest(
  projectId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ManifestQueryResult> {
  try {
    return {
      manifest: await getManifest(projectId, sessionId, { signal }),
      mode: "recorded",
      notFound: false,
    };
  } catch (caughtError) {
    if (!isNotFound(caughtError)) throw caughtError;

    const liveSessions = await fetchLiveSessions(projectId, { signal });
    const liveSession = liveSessions.sessions.find((session) => session.session_id === sessionId);
    if (liveSession === undefined) {
      return { manifest: null, mode: "recorded", notFound: true };
    }

    return {
      manifest: liveSessionManifest(projectId, sessionId, liveSession),
      mode: "live",
      notFound: false,
    };
  }
}

function liveSessionManifest(
  projectId: string,
  sessionId: string,
  session: LiveSessionItem,
): SessionManifest {
  const startedAt = session.started_at;
  const durationMs = Math.max(0, session.duration_ms);
  const endedAt = Math.max(session.last_seen, startedAt + durationMs);
  const country = cleanOptionalText(session.country);
  const city = cleanOptionalText(session.city);
  const browser = cleanOptionalText(session.browser);
  const os = cleanOptionalText(session.os);
  const device = cleanOptionalText(session.device);
  const entryUrl = cleanOptionalText(session.entry_url);
  const attrs: SessionManifest["attrs"] = {
    ...(country !== undefined ? { country } : {}),
    ...(city !== undefined ? { city } : {}),
    ...(browser !== undefined ? { browser } : {}),
    ...(os !== undefined ? { os } : {}),
    ...(device !== undefined ? { device } : {}),
    ...(entryUrl !== undefined ? { entryUrl } : {}),
  };

  return {
    v: 1,
    sessionId,
    projectId,
    orgId: "live",
    startedAt,
    endedAt,
    durationMs,
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
    flags: 0,
    attrs,
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function cleanOptionalText(value: string | null): string | undefined {
  const cleanValue = value?.trim();
  return cleanValue === undefined || cleanValue.length === 0 ? undefined : cleanValue;
}
