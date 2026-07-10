import { describe, expect, it } from "vite-plus/test";
import type { FinalizeMessage } from "@orange-replay/shared";
import {
  buildSessionManifest,
  capFinalizeMessageToBudget,
  capTimelineEventsToBudget,
  countTimelineEvents,
  FINALIZE_MESSAGE_BUDGET_BYTES,
  filterFinalizeEvents,
  MAX_MANIFEST_TIMELINE_EVENTS,
  MAX_SEGMENT_TIMELINE_BYTES,
} from "../src/do/session-logic.ts";
import type { SegmentForManifest, SessionState } from "../src/do/session-logic.ts";

describe("SessionRecorder pure logic", () => {
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
      totalEventBytes: 10,
      batchCount: 2,
      segmentCount: 2,
      flags: 3,
      attrs: { country: "US" },
      firstRequestId: "req-1",
      entryUrl: "/home",
      urlCount: 2,
      analyticsVersion: 2,
      pageCount: 3,
      quickBacks: 0,
      pageTabs: [{ tab: "tab-a", url: "/home" }],
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

    expect(countTimelineEvents(segments)).toBe(4);
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
    expect(manifest.attrs).toEqual({
      country: "US",
      entryUrl: "/home",
      urlCount: 2,
      pageCount: 3,
    });
    expect(manifest.enc).toEqual({ k: "key-1" });

    const legacyManifest = buildSessionManifest(
      { ...state, analyticsVersion: 0, pageCount: 0 },
      segments,
    );
    expect(legacyManifest.attrs.pageCount).toBeUndefined();
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
      totalEventBytes: 0,
      batchCount: 0,
      segmentCount: 1,
      flags: 0,
      attrs: {},
      firstRequestId: "request",
      urlCount: 0,
      analyticsVersion: 2,
      pageCount: 0,
      quickBacks: 0,
      pageTabs: [],
    };
    const fullTimeline = Array.from({ length: MAX_MANIFEST_TIMELINE_EVENTS + 5 }, (_, index) => ({
      t: index,
      k: "custom" as const,
    }));
    const segments: SegmentForManifest[] = [
      {
        key: "p/project/session/seg-000001.ors",
        bytes: 1,
        t0: 0,
        t1: 1,
        batches: 1,
        events: fullTimeline.slice(0, 10),
      },
    ];

    const manifest = buildSessionManifest(state, segments, fullTimeline);

    expect(manifest.timeline).toHaveLength(MAX_MANIFEST_TIMELINE_EVENTS);
    expect(manifest.counts.events).toBe(MAX_MANIFEST_TIMELINE_EVENTS + 5);
  });

  it("keeps a late rage marker when ordinary timeline events are capped", () => {
    const events = [
      ...Array.from({ length: 20 }, (_, index) => ({ t: index, k: "scroll" as const })),
      { t: 100, k: "rage" as const, d: "Rage click burst" },
    ];

    const capped = capTimelineEventsToBudget(events, 5, 10_000);

    expect(capped).toHaveLength(5);
    expect(capped.at(-1)).toEqual({ t: 100, k: "rage", d: "Rage click burst" });
  });

  it("caps timeline events by serialized bytes", () => {
    const events = Array.from({ length: 10 }, (_, index) => ({
      t: index,
      k: "custom" as const,
      d: "x".repeat(200),
      m: { detail: "y".repeat(200) },
    }));

    const capped = capTimelineEventsToBudget(events, 10, 900);

    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThan(events.length);
    expect(new TextEncoder().encode(JSON.stringify(capped)).byteLength).toBeLessThanOrEqual(900);
  });

  it("keeps segment timeline JSON under the Durable Object byte budget", () => {
    const events = Array.from({ length: MAX_MANIFEST_TIMELINE_EVENTS }, (_, index) => ({
      t: index,
      k: "custom" as const,
      d: "x".repeat(200),
      m: Object.fromEntries(
        Array.from({ length: 16 }, (__, metaIndex) => [
          `key-${metaIndex}`.padEnd(200, "k"),
          "v".repeat(200),
        ]),
      ),
    }));

    const capped = capTimelineEventsToBudget(events);

    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThan(events.length);
    expect(new TextEncoder().encode(JSON.stringify(capped)).byteLength).toBeLessThanOrEqual(
      MAX_SEGMENT_TIMELINE_BYTES,
    );
  });
});
