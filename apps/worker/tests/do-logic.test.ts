import { describe, expect, it } from "vite-plus/test";
import {
  CLOSE_SESSION_AFTER_IDLE_MS,
  FLUSH_TAIL_AFTER_IDLE_MS,
  SEGMENT_FLUSH_BYTES,
  SEGMENT_FLUSH_INTERVAL_MS,
} from "@orange-replay/shared";
import {
  buildSessionManifest,
  decideSegmentFlush,
  filterFinalizeEvents,
  resolveSessionTiming,
} from "../src/do/session-logic.ts";
import type { SegmentForManifest, SessionState } from "../src/do/session-logic.ts";

describe("SessionRecorder pure logic", () => {
  it("uses default timings unless dev test routes are enabled", () => {
    expect(resolveSessionTiming(undefined, JSON.stringify({ closeMs: 1 }))).toEqual({
      segmentFlushBytes: SEGMENT_FLUSH_BYTES,
      segmentFlushMs: SEGMENT_FLUSH_INTERVAL_MS,
      flushTailMs: FLUSH_TAIL_AFTER_IDLE_MS,
      closeMs: CLOSE_SESSION_AFTER_IDLE_MS,
    });

    expect(
      resolveSessionTiming(
        "1",
        JSON.stringify({
          segmentFlushBytes: 100,
          segmentFlushMs: 200,
          flushTailMs: 300,
          closeMs: 400,
        }),
      ),
    ).toEqual({
      segmentFlushBytes: 100,
      segmentFlushMs: 200,
      flushTailMs: 300,
      closeMs: 400,
    });
  });

  it("decides when buffered batches should flush", () => {
    const timing = {
      segmentFlushBytes: 100,
      segmentFlushMs: 50,
      flushTailMs: 500,
      closeMs: 1000,
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
      urls: ["/home", "/cart"],
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
    expect(events[0]?.k).toBe("custom");
    expect(events[0]?.d).toHaveLength(200);
    expect(events.every((event) => event.k === "custom" || event.k === "error")).toBe(true);
  });
});
