import {
  CLOSE_SESSION_AFTER_IDLE_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_SHARD_COUNT,
  PRESENCE_TTL_MS,
  hashToUnit,
  type LiveSessionItem,
} from "@orange-replay/shared";

export const SESSION_HEAD_HANDOFF_GRACE_MS = 5 * 60 * 1000;

export interface PresenceTiming {
  ttlMs: number;
  heartbeatMs: number;
  closeMs: number;
  headGraceMs: number;
  forceFailure: boolean;
}

export interface PresenceSession {
  session_id: string;
  org_id?: string | null;
  started_at: number;
  last_seen: number;
  finalizing_at?: number | null;
  entry_url: string | null;
  country: string | null;
  region?: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  flags?: number;
}

export type SessionActivity = "live" | "idle" | "finalizing";

export interface PresenceSessionHead extends PresenceSession {
  activity: SessionActivity;
}

export type PresenceHeadSort = "newest" | "duration";

export interface PresenceHeadCursor {
  sortValue: number;
  sessionId?: string;
}

export interface PresenceHeadQuery {
  now: number;
  limit: number;
  sort: PresenceHeadSort;
  trackedSessionIds?: string[];
  before?: PresenceHeadCursor;
  from?: number;
  to?: number;
  country?: string;
  region?: string;
  city?: string;
  device?: string;
  browser?: string;
  os?: string;
  entryUrl?: string;
  entryUrlPrefix?: string;
  minDurationMs?: number;
}

export type LiveSession = LiveSessionItem;

export const defaultPresenceTiming: PresenceTiming = {
  ttlMs: PRESENCE_TTL_MS,
  heartbeatMs: PRESENCE_HEARTBEAT_MS,
  closeMs: CLOSE_SESSION_AFTER_IDLE_MS,
  headGraceMs: SESSION_HEAD_HANDOFF_GRACE_MS,
  forceFailure: false,
};

export function presenceShardIndex(sessionId: string): number {
  return Math.min(
    PRESENCE_SHARD_COUNT - 1,
    Math.floor(hashToUnit(sessionId) * PRESENCE_SHARD_COUNT),
  );
}

export function presenceShardName(projectId: string, shard: number): string {
  return `${projectId}:presence:${shard}`;
}

export function presenceShardNames(projectId: string): string[] {
  return Array.from({ length: PRESENCE_SHARD_COUNT }, (_, shard) =>
    presenceShardName(projectId, shard),
  );
}

export function resolvePresenceTiming(
  devTestRoutes: string | undefined,
  rawOverride: string | undefined,
): PresenceTiming {
  if (devTestRoutes !== "1" || rawOverride === undefined || rawOverride.trim() === "") {
    return { ...defaultPresenceTiming };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOverride);
  } catch {
    return { ...defaultPresenceTiming };
  }

  if (!isRecord(parsed)) {
    return { ...defaultPresenceTiming };
  }

  return {
    ttlMs: readPositiveNumber(parsed["presenceTtlMs"], PRESENCE_TTL_MS),
    heartbeatMs: readPositiveNumber(parsed["presenceHeartbeatMs"], PRESENCE_HEARTBEAT_MS),
    closeMs: readPositiveNumber(parsed["closeMs"], CLOSE_SESSION_AFTER_IDLE_MS),
    headGraceMs: readPositiveNumber(parsed["sessionHeadGraceMs"], SESSION_HEAD_HANDOFF_GRACE_MS),
    forceFailure: parsed["forcePresenceFailure"] === true,
  };
}

export function shouldSendPresencePing(input: {
  lastPingAt: number | undefined;
  now: number;
  heartbeatMs: number;
}): boolean {
  return input.lastPingAt === undefined || input.now - input.lastPingAt >= input.heartbeatMs;
}

export function liveSessionsFromPresenceRows(
  rows: readonly PresenceSession[],
  now: number,
): LiveSession[] {
  return rows.map((row) => ({
    session_id: row.session_id,
    started_at: row.started_at,
    last_seen: row.last_seen,
    entry_url: row.entry_url,
    country: row.country,
    city: row.city,
    browser: row.browser,
    os: row.os,
    device: row.device,
    duration_ms: Math.max(0, now - row.started_at),
  }));
}

export function sessionActivity(
  row: Pick<PresenceSession, "last_seen" | "finalizing_at">,
  now: number,
  ttlMs: number,
): SessionActivity {
  if (row.finalizing_at !== null && row.finalizing_at !== undefined) return "finalizing";
  return row.last_seen >= now - ttlMs ? "live" : "idle";
}

function readPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
