import { describe, expect, it } from "vite-plus/test";
import {
  CLOSE_SESSION_AFTER_IDLE_MS,
  FLUSH_TAIL_AFTER_IDLE_MS,
  MAX_BATCHES_PER_SEGMENT,
  SEGMENT_FLUSH_BYTES,
  SEGMENT_FLUSH_INTERVAL_MS,
  SDK_FLUSH_DEFAULT_MS,
  SDK_FLUSH_LIVE_MS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_TTL_MS,
} from "@orange-replay/shared";
import type { FinalizeMessage } from "@orange-replay/shared";
import {
  buildSessionManifest,
  capFinalizeMessageToBudget,
  chunkForSegments,
  clampIndexForStorage,
  decideSegmentFlush,
  FINALIZE_MESSAGE_BUDGET_BYTES,
  filterFinalizeEvents,
  MAX_MANIFEST_TIMELINE_EVENTS,
  nextAlarmAfterAlarm,
  resolveSessionTiming,
  sdkFlushMs,
  shouldDropForSessionCap,
  shouldSetAlarm,
} from "../src/do/session-logic.ts";
import type { SegmentForManifest, SessionState } from "../src/do/session-logic.ts";
import {
  liveSessionsFromPresenceRows,
  resolvePresenceTiming,
  shouldSendPresencePing,
} from "../src/do/presence-logic.ts";

describe("SessionRecorder pure logic", () => {
  it("uses default timings unless dev test routes are enabled", () => {
    expect(resolveSessionTiming(undefined, JSON.stringify({ closeMs: 1 }))).toEqual({
      segmentFlushBytes: SEGMENT_FLUSH_BYTES,
      segmentFlushMs: SEGMENT_FLUSH_INTERVAL_MS,
      flushTailMs: FLUSH_TAIL_AFTER_IDLE_MS,
      closeMs: CLOSE_SESSION_AFTER_IDLE_MS,
      sdkFlushMs: SDK_FLUSH_DEFAULT_MS,
      sdkFlushLiveMs: SDK_FLUSH_LIVE_MS,
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
        }),
      ),
    ).toEqual({
      segmentFlushBytes: 100,
      segmentFlushMs: 200,
      flushTailMs: 300,
      closeMs: 400,
      sdkFlushMs: 500,
      sdkFlushLiveMs: 250,
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

  it("assembles a manifest from segment rows", () => {
    const state: SessionState = {
      projectId: "project",
      orgId: "org",
      shard: 2,
      retentionDays: 14,
      sessionId: "session",
      startedAt: 1000,
      lastActivity: 1800,
      lastFlushAt: 1600,
      bufferedBytes: 0,
      totalPayloadBytes: 10,
      batchCount: 2,
      segmentCount: 2,
      flags: 3,
      attrs: { country: "US" },
      firstRequestId: "req-1",
      entryUrl: "/home",
      urlCount: 2,
      encKeyId: "key-1",
    };
    const segments: SegmentForManifest[] = [
      {
        key: "p/project/session/seg-000001.ors",
        bytes: 50,
        t0: 1000,
        t1: 1300,
        batches: 1,
        events: [
          { t: 1200, k: "error", d: "bad" },
          { t: 1100, k: "click" },
        ],
      },
      {
        key: "p/project/session/seg-000002.ors",
        bytes: 40,
        t0: 1400,
        t1: 1700,
        batches: 1,
        events: [
          { t: 1600, k: "nav" },
          { t: 1500, k: "rage" },
        ],
      },
    ];

    const manifest = buildSessionManifest(state, segments);

    expect(manifest.timeline.map((event) => event.t)).toEqual([1100, 1200, 1500, 1600]);
    expect(manifest.counts).toEqual({
      batches: 2,
      events: 4,
      clicks: 1,
      errors: 1,
      rages: 1,
      navs: 1,
    });
    expect(manifest.bytes).toBe(90);
    expect(manifest.flags).toBe(3);
    expect(manifest.endedAt).toBe(1800);
    expect(manifest.attrs).toEqual({ country: "US", entryUrl: "/home", urlCount: 2 });
    expect(manifest.enc).toEqual({ k: "key-1" });
  });

  it("filters and caps finalize events", () => {
    const longDetail = "x".repeat(250);
    const timeline = [
      { t: 1, k: "click" as const },
      ...Array.from({ length: 205 }, (_, index) => ({
        t: index + 2,
        k: index % 2 === 0 ? ("custom" as const) : ("error" as const),
        d: longDetail,
      })),
    ];

    const events = filterFinalizeEvents(timeline);

    expect(events).toHaveLength(200);
    expect(events[0]?.k).toBe("error");
    expect(events[0]?.d).toHaveLength(200);
    expect(events.every((event) => event.k === "custom" || event.k === "error")).toBe(true);
  });

  it("chunks rows into valid segment-sized groups", () => {
    const rows = Array.from({ length: MAX_BATCHES_PER_SEGMENT + 3 }, (_, index) => index);

    const chunks = chunkForSegments(rows);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_BATCHES_PER_SEGMENT);
    expect(chunks[1]).toEqual([
      MAX_BATCHES_PER_SEGMENT,
      MAX_BATCHES_PER_SEGMENT + 1,
      MAX_BATCHES_PER_SEGMENT + 2,
    ]);
  });

  it("caps finalize messages to the queue size budget", () => {
    const message: FinalizeMessage = {
      type: "session.finalized",
      sessionId: "session",
      projectId: "project",
      orgId: "org",
      shard: 0,
      requestId: "request",
      manifestKey: "p/project/session/manifest.json",
      startedAt: 1,
      endedAt: 2,
      bytes: 3,
      segments: 1,
      flags: 0,
      counts: { batches: 1, events: 200, clicks: 0, errors: 200, rages: 0, navs: 0 },
      attrs: {},
      retentionDays: 30,
      events: Array.from({ length: 200 }, (_, index) => ({
        t: index,
        k: "error" as const,
        d: "🔥".repeat(200),
        m: Object.fromEntries(
          Array.from({ length: 16 }, (__, metaIndex) => [`k${metaIndex}`, "🔥".repeat(20)]),
        ),
      })),
    };

    const capped = capFinalizeMessageToBudget(message);
    const bytes = new TextEncoder().encode(JSON.stringify(capped)).byteLength;

    expect(bytes).toBeLessThanOrEqual(FINALIZE_MESSAGE_BUDGET_BYTES);
    expect(capped.events.length).toBeLessThan(message.events.length);
    expect(capped.events[0]).toEqual(message.events[0]);
  });

  it("clamps client times into the server receive window", () => {
    const startedAt = 1_000_000;
    const receivedAt = 2_000_000;

    const clamped = clampIndexForStorage(
      {
        v: 1,
        s: "session",
        tab: "tab",
        seq: 0,
        t0: startedAt - 100_000_000,
        t1: receivedAt + 200_000,
        e: [{ t: receivedAt + 200_000, k: "custom" }],
      },
      startedAt,
      receivedAt,
    );

    expect(clamped.t0).toBe(startedAt - 86_400_000);
    expect(clamped.t1).toBe(receivedAt + 60_000);
    expect(clamped.e[0]?.t).toBe(receivedAt + 60_000);
  });

  it("caps manifest timelines without changing the shared manifest type", () => {
    const state: SessionState = {
      projectId: "project",
      orgId: "org",
      shard: 0,
      retentionDays: 30,
      sessionId: "session",
      startedAt: 0,
      lastActivity: 1,
      lastFlushAt: 1,
      bufferedBytes: 0,
      totalPayloadBytes: 0,
      batchCount: 0,
      segmentCount: 1,
      flags: 0,
      attrs: {},
      firstRequestId: "request",
      urlCount: 0,
    };
    const segments: SegmentForManifest[] = [
      {
        key: "p/project/session/seg-000001.ors",
        bytes: 1,
        t0: 0,
        t1: 1,
        batches: 1,
        events: Array.from({ length: MAX_MANIFEST_TIMELINE_EVENTS + 5 }, (_, index) => ({
          t: index,
          k: "custom" as const,
        })),
      },
    ];

    const manifest = buildSessionManifest(state, segments);

    expect(manifest.timeline).toHaveLength(MAX_MANIFEST_TIMELINE_EVENTS);
    expect(manifest.counts.events).toBe(MAX_MANIFEST_TIMELINE_EVENTS);
  });

  it("drops new batches when the per-session caps are reached", () => {
    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 512 * 1024 * 1024,
        batchCount: 1,
        payloadBytes: 1,
      }),
    ).toBe(true);

    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 10,
        batchCount: 10_000_000,
        payloadBytes: 1,
      }),
    ).toBe(true);

    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 10,
        batchCount: 1,
        payloadBytes: 1,
      }),
    ).toBe(false);
  });

  it("re-arms pending tail work at the tail flush deadline", () => {
    const timing = {
      segmentFlushBytes: 100,
      segmentFlushMs: 100,
      flushTailMs: 500,
      closeMs: 5000,
      sdkFlushMs: SDK_FLUSH_DEFAULT_MS,
      sdkFlushLiveMs: SDK_FLUSH_LIVE_MS,
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
});

describe("PresenceRegistry pure logic", () => {
  it("uses default timings unless dev test routes are enabled", () => {
    expect(resolvePresenceTiming(undefined, JSON.stringify({ presenceTtlMs: 1 }))).toEqual({
      ttlMs: PRESENCE_TTL_MS,
      heartbeatMs: PRESENCE_HEARTBEAT_MS,
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
