import { PRESENCE_HEARTBEAT_MS, PRESENCE_TTL_MS } from "@orange-replay/shared";

export interface PresenceTiming {
  ttlMs: number;
  heartbeatMs: number;
  forceFailure: boolean;
}

export interface PresenceSession {
  session_id: string;
  started_at: number;
  last_seen: number;
  entry_url: string | null;
  country: string | null;
  city: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
}

export interface LiveSession extends PresenceSession {
  duration_ms: number;
}

export const defaultPresenceTiming: PresenceTiming = {
  ttlMs: PRESENCE_TTL_MS,
  heartbeatMs: PRESENCE_HEARTBEAT_MS,
  forceFailure: false,
};

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
    ...row,
    duration_ms: Math.max(0, now - row.started_at),
  }));
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
