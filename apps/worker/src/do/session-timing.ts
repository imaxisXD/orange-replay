import {
  CLOSE_SESSION_AFTER_IDLE_MS,
  FLUSH_TAIL_AFTER_IDLE_MS,
  SDK_FLUSH_DEFAULT_MS,
  SDK_FLUSH_LIVE_MS,
  SEGMENT_FLUSH_BYTES,
  SEGMENT_FLUSH_INTERVAL_MS,
  SESSION_APPEND_RATE_LIMIT_COUNT,
  SESSION_APPEND_RATE_LIMIT_WINDOW_MS,
} from "@orange-replay/shared";

export interface SessionTiming {
  segmentFlushBytes: number;
  segmentFlushMs: number;
  flushTailMs: number;
  closeMs: number;
  sdkFlushMs: number;
  sdkFlushLiveMs: number;
  appendRateLimitCount: number;
  appendRateLimitWindowMs: number;
}

export type AppendFlushReason = "bytes" | "interval";
export type SegmentFlushReason = AppendFlushReason | "tail_flush" | "finalize";

export interface FlushDecision {
  shouldFlush: boolean;
  reason?: AppendFlushReason;
}

export interface AppendRateLimitState {
  windowStartedAt: number;
  count: number;
}

export const defaultSessionTiming: SessionTiming = {
  segmentFlushBytes: SEGMENT_FLUSH_BYTES,
  segmentFlushMs: SEGMENT_FLUSH_INTERVAL_MS,
  flushTailMs: FLUSH_TAIL_AFTER_IDLE_MS,
  closeMs: CLOSE_SESSION_AFTER_IDLE_MS,
  sdkFlushMs: SDK_FLUSH_DEFAULT_MS,
  sdkFlushLiveMs: SDK_FLUSH_LIVE_MS,
  appendRateLimitCount: SESSION_APPEND_RATE_LIMIT_COUNT,
  appendRateLimitWindowMs: SESSION_APPEND_RATE_LIMIT_WINDOW_MS,
};

export function resolveSessionTiming(
  devTestRoutes: string | undefined,
  rawOverride: string | undefined,
): SessionTiming {
  if (devTestRoutes !== "1" || rawOverride === undefined || rawOverride.trim() === "") {
    return { ...defaultSessionTiming };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOverride);
  } catch {
    return { ...defaultSessionTiming };
  }

  if (!isRecord(parsed)) {
    return { ...defaultSessionTiming };
  }

  return {
    segmentFlushBytes: readPositiveNumber(parsed["segmentFlushBytes"], SEGMENT_FLUSH_BYTES),
    segmentFlushMs: readPositiveNumber(parsed["segmentFlushMs"], SEGMENT_FLUSH_INTERVAL_MS),
    flushTailMs: readPositiveNumber(parsed["flushTailMs"], FLUSH_TAIL_AFTER_IDLE_MS),
    closeMs: readPositiveNumber(parsed["closeMs"], CLOSE_SESSION_AFTER_IDLE_MS),
    sdkFlushMs: readPositiveNumber(parsed["sdkFlushMs"], SDK_FLUSH_DEFAULT_MS),
    sdkFlushLiveMs: readPositiveNumber(parsed["sdkFlushLiveMs"], SDK_FLUSH_LIVE_MS),
    appendRateLimitCount: readPositiveNumber(
      parsed["appendRateLimitCount"],
      SESSION_APPEND_RATE_LIMIT_COUNT,
    ),
    appendRateLimitWindowMs: readPositiveNumber(
      parsed["appendRateLimitWindowMs"],
      SESSION_APPEND_RATE_LIMIT_WINDOW_MS,
    ),
  };
}

export function trackAppendRateLimit(
  state: AppendRateLimitState,
  now: number,
  timing: Pick<SessionTiming, "appendRateLimitCount" | "appendRateLimitWindowMs">,
): boolean {
  if (
    state.windowStartedAt <= 0 ||
    now < state.windowStartedAt ||
    now - state.windowStartedAt >= timing.appendRateLimitWindowMs
  ) {
    state.windowStartedAt = now;
    state.count = 0;
  }

  state.count += 1;
  return state.count > timing.appendRateLimitCount;
}

export function decideSegmentFlush(input: {
  bufferedBytes: number;
  pendingBatches: number;
  receivedAt: number;
  lastFlushAt: number;
  timing: SessionTiming;
}): FlushDecision {
  if (input.pendingBatches < 1) {
    return { shouldFlush: false };
  }

  if (input.bufferedBytes >= input.timing.segmentFlushBytes) {
    return { shouldFlush: true, reason: "bytes" };
  }

  if (input.receivedAt - input.lastFlushAt >= input.timing.segmentFlushMs) {
    return { shouldFlush: true, reason: "interval" };
  }

  return { shouldFlush: false };
}

export function shouldSetAlarm(input: {
  alarmAt: number | null;
  now: number;
  desiredAt: number;
  flushTailMs: number;
}): boolean {
  return (
    input.alarmAt === null ||
    input.alarmAt <= input.now ||
    input.alarmAt > input.desiredAt + 2 * input.flushTailMs
  );
}

export function nextAlarmAfterAlarm(input: {
  lastActivity: number;
  pendingBatches: number;
  timing: SessionTiming;
}): number {
  if (input.pendingBatches > 0) {
    return input.lastActivity + input.timing.flushTailMs;
  }

  return input.lastActivity + input.timing.closeMs;
}

export function sdkFlushMs(live: boolean, timing: SessionTiming = defaultSessionTiming): number {
  return live ? timing.sdkFlushLiveMs : timing.sdkFlushMs;
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
