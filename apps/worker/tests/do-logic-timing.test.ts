import { describe, expect, it } from "vite-plus/test";
import {
  CLOSE_SESSION_AFTER_IDLE_MS,
  FLUSH_TAIL_AFTER_IDLE_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_SHARD_COUNT,
  PRESENCE_TTL_MS,
  SEGMENT_FLUSH_BYTES,
  SEGMENT_FLUSH_INTERVAL_MS,
  SDK_FLUSH_DEFAULT_MS,
  SDK_FLUSH_LIVE_MS,
  SESSION_APPEND_RATE_LIMIT_COUNT,
  SESSION_APPEND_RATE_LIMIT_WINDOW_MS,
} from "@orange-replay/shared";
import {
  decideSegmentFlush,
  nextAlarmAfterAlarm,
  resolveSessionTiming,
  sdkFlushMs,
  shouldSetAlarm,
  trackAppendRateLimit,
} from "../src/do/session-logic.ts";
import {
  SESSION_HEAD_HANDOFF_GRACE_MS,
  liveSessionsFromPresenceRows,
  presenceShardIndex,
  presenceShardNames,
  resolvePresenceTiming,
  shouldSendPresencePing,
} from "../src/do/presence-logic.ts";
import { shouldFailPresenceHeadShardForTest } from "../src/do/presence-client.ts";

describe("SessionRecorder pure logic", () => {
  it("uses default timings unless dev test routes are enabled", () => {
    expect(resolveSessionTiming(undefined, JSON.stringify({ closeMs: 1 }))).toEqual({
      segmentFlushBytes: SEGMENT_FLUSH_BYTES,
      segmentFlushMs: SEGMENT_FLUSH_INTERVAL_MS,
      flushTailMs: FLUSH_TAIL_AFTER_IDLE_MS,
      closeMs: CLOSE_SESSION_AFTER_IDLE_MS,
      sdkFlushMs: SDK_FLUSH_DEFAULT_MS,
      sdkFlushLiveMs: SDK_FLUSH_LIVE_MS,
      appendRateLimitCount: SESSION_APPEND_RATE_LIMIT_COUNT,
      appendRateLimitWindowMs: SESSION_APPEND_RATE_LIMIT_WINDOW_MS,
    });

    expect(
      resolveSessionTiming(
        "1",
        JSON.stringify({
          segmentFlushBytes: 100,
          segmentFlushMs: 200,
          flushTailMs: 300,
          closeMs: 400,
          sdkFlushMs: 500,
          sdkFlushLiveMs: 250,
          appendRateLimitCount: 2,
          appendRateLimitWindowMs: 1000,
        }),
      ),
    ).toEqual({
      segmentFlushBytes: 100,
      segmentFlushMs: 200,
      flushTailMs: 300,
      closeMs: 400,
      sdkFlushMs: 500,
      sdkFlushLiveMs: 250,
      appendRateLimitCount: 2,
      appendRateLimitWindowMs: 1000,
    });
  });

  it("serves the sdk cadence from timing overrides", () => {
    expect(sdkFlushMs(false)).toBe(SDK_FLUSH_DEFAULT_MS);
    expect(sdkFlushMs(true)).toBe(SDK_FLUSH_LIVE_MS);
    const timing = resolveSessionTiming(
      "1",
      JSON.stringify({ sdkFlushMs: 900, sdkFlushLiveMs: 450 }),
    );
    expect(sdkFlushMs(false, timing)).toBe(900);
    expect(sdkFlushMs(true, timing)).toBe(450);
  });

  it("decides when buffered batches should flush", () => {
    const timing = {
      segmentFlushBytes: 100,
      segmentFlushMs: 50,
      flushTailMs: 500,
      closeMs: 1000,
      sdkFlushMs: SDK_FLUSH_DEFAULT_MS,
      sdkFlushLiveMs: SDK_FLUSH_LIVE_MS,
      appendRateLimitCount: SESSION_APPEND_RATE_LIMIT_COUNT,
      appendRateLimitWindowMs: SESSION_APPEND_RATE_LIMIT_WINDOW_MS,
    };

    expect(
      decideSegmentFlush({
        bufferedBytes: 100,
        pendingBatches: 1,
        receivedAt: 10,
        lastFlushAt: 0,
        timing,
      }),
    ).toEqual({ shouldFlush: true, reason: "bytes" });

    expect(
      decideSegmentFlush({
        bufferedBytes: 10,
        pendingBatches: 1,
        receivedAt: 50,
        lastFlushAt: 0,
        timing,
      }),
    ).toEqual({ shouldFlush: true, reason: "interval" });

    expect(
      decideSegmentFlush({
        bufferedBytes: 10,
        pendingBatches: 0,
        receivedAt: 100,
        lastFlushAt: 0,
        timing,
      }),
    ).toEqual({ shouldFlush: false });
  });

  it("tracks append rate in memory without storage state", () => {
    const state = { windowStartedAt: 0, count: 0 };
    const timing = {
      appendRateLimitCount: 2,
      appendRateLimitWindowMs: 1000,
    };

    expect(trackAppendRateLimit(state, 100, timing)).toBe(false);
    expect(trackAppendRateLimit(state, 200, timing)).toBe(false);
    expect(trackAppendRateLimit(state, 300, timing)).toBe(true);
    expect(trackAppendRateLimit(state, 1200, timing)).toBe(false);
  });

  it("re-arms pending tail work at the tail flush deadline", () => {
    const timing = {
      segmentFlushBytes: 100,
      segmentFlushMs: 100,
      flushTailMs: 500,
      closeMs: 5000,
      sdkFlushMs: SDK_FLUSH_DEFAULT_MS,
      sdkFlushLiveMs: SDK_FLUSH_LIVE_MS,
      appendRateLimitCount: SESSION_APPEND_RATE_LIMIT_COUNT,
      appendRateLimitWindowMs: SESSION_APPEND_RATE_LIMIT_WINDOW_MS,
    };

    expect(nextAlarmAfterAlarm({ lastActivity: 1000, pendingBatches: 1, timing })).toBe(1500);
    expect(nextAlarmAfterAlarm({ lastActivity: 1000, pendingBatches: 0, timing })).toBe(6000);

    expect(
      shouldSetAlarm({
        alarmAt: 5000,
        now: 1200,
        desiredAt: 1500,
        flushTailMs: 500,
      }),
    ).toBe(true);
    expect(
      shouldSetAlarm({
        alarmAt: 1700,
        now: 1200,
        desiredAt: 1500,
        flushTailMs: 500,
      }),
    ).toBe(false);
  });

  it("recognizes a stored close alarm that must move forward after the timeout shrinks", () => {
    const timing = resolveSessionTiming(undefined, undefined);
    const lastActivity = 10_000;
    const desiredAt = nextAlarmAfterAlarm({
      lastActivity,
      pendingBatches: 0,
      timing,
    });

    expect(desiredAt).toBe(lastActivity + CLOSE_SESSION_AFTER_IDLE_MS);
    expect(
      shouldSetAlarm({
        alarmAt: lastActivity + 30 * 60_000,
        now: lastActivity + 1,
        desiredAt,
        flushTailMs: timing.flushTailMs,
      }),
    ).toBe(true);
  });
});

describe("PresenceRegistry pure logic", () => {
  it("never enables the failed-shard test hook in production", () => {
    expect(
      shouldFailPresenceHeadShardForTest(
        {
          WORKER_ENV: "production",
          DEV_TEST_ROUTES: "1",
          TEST_FAIL_PRESENCE_HEAD_SHARD: "0",
        },
        0,
      ),
    ).toBe(false);
    expect(
      shouldFailPresenceHeadShardForTest(
        {
          WORKER_ENV: "development",
          DEV_TEST_ROUTES: "1",
          TEST_FAIL_PRESENCE_HEAD_SHARD: "0",
        },
        0,
      ),
    ).toBe(true);
  });

  it("routes every session to one stable project shard", () => {
    const first = presenceShardIndex("session-stable");
    expect(presenceShardIndex("session-stable")).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(PRESENCE_SHARD_COUNT);
    expect(presenceShardNames("project_1")).toHaveLength(PRESENCE_SHARD_COUNT);
    expect(new Set(presenceShardNames("project_1")).size).toBe(PRESENCE_SHARD_COUNT);
  });

  it("uses default timings unless dev test routes are enabled", () => {
    expect(resolvePresenceTiming(undefined, JSON.stringify({ presenceTtlMs: 1 }))).toEqual({
      ttlMs: PRESENCE_TTL_MS,
      heartbeatMs: PRESENCE_HEARTBEAT_MS,
      closeMs: CLOSE_SESSION_AFTER_IDLE_MS,
      headGraceMs: SESSION_HEAD_HANDOFF_GRACE_MS,
      forceFailure: false,
    });

    expect(
      resolvePresenceTiming(
        "1",
        JSON.stringify({
          presenceTtlMs: 100,
          presenceHeartbeatMs: 50,
          forcePresenceFailure: true,
        }),
      ),
    ).toEqual({
      ttlMs: 100,
      heartbeatMs: 50,
      closeMs: CLOSE_SESSION_AFTER_IDLE_MS,
      headGraceMs: SESSION_HEAD_HANDOFF_GRACE_MS,
      forceFailure: true,
    });
  });

  it("throttles pings by heartbeat window", () => {
    expect(
      shouldSendPresencePing({
        lastPingAt: undefined,
        now: 1000,
        heartbeatMs: 200,
      }),
    ).toBe(true);
    expect(
      shouldSendPresencePing({
        lastPingAt: 1000,
        now: 1100,
        heartbeatMs: 200,
      }),
    ).toBe(false);
    expect(
      shouldSendPresencePing({
        lastPingAt: 1000,
        now: 1200,
        heartbeatMs: 200,
      }),
    ).toBe(true);
  });

  it("adds live durations without changing stored presence rows", () => {
    expect(
      liveSessionsFromPresenceRows(
        [
          {
            session_id: "session",
            started_at: 1000,
            last_seen: 1500,
            entry_url: "/",
            country: "US",
            city: null,
            browser: "Chrome",
            os: "macOS",
            device: "desktop",
          },
        ],
        1800,
      ),
    ).toEqual([
      {
        session_id: "session",
        started_at: 1000,
        last_seen: 1500,
        entry_url: "/",
        country: "US",
        city: null,
        browser: "Chrome",
        os: "macOS",
        device: "desktop",
        duration_ms: 800,
      },
    ]);
  });
});
