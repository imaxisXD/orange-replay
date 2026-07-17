import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { analyticsSidecarKey, manifestKey } from "@orange-replay/shared";
import type { SessionManifest } from "@orange-replay/shared";
import {
  append,
  appendStatus,
  bytes,
  configureUsageReservationFailure,
  forceFinalize,
  readDebug,
  readR2Bytes,
  readUsage,
  readUsageLedger,
  seedBatches,
  waitForR2Bytes,
} from "./do-test-helpers.ts";
import type { AppendInput } from "./do-test-helpers.ts";

describe("SessionRecorder Durable Object", () => {
  it("charges accepted bytes before finalization and does not charge a duplicate twice", async () => {
    const projectId = "project-accepted-usage";
    const sessionId = "session-accepted-usage";
    const orgId = "org-accepted-usage";
    const receivedAt = Date.now();
    const input = {
      projectId,
      orgId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("charge-before-finalization"),
      t0: receivedAt,
      receivedAt,
    };

    expect(await readUsage(orgId)).toEqual([]);
    await append(input);
    const afterAccepted = await readUsage(orgId);
    expect(afterAccepted).toHaveLength(1);
    expect(afterAccepted[0]?.["sessions"]).toBe(0);
    expect(Number(afterAccepted[0]?.["bytes"])).toBeGreaterThan(input.payload.byteLength);
    const firstLedger = await readUsageLedger(projectId, sessionId);
    expect(firstLedger).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await append(input);
    expect(await readUsage(orgId)).toEqual(afterAccepted);
    expect(await readUsageLedger(projectId, sessionId)).toEqual(firstLedger);
  });

  it("repairs a failed D1 reservation on the duplicate retry", async () => {
    const projectId = "project-usage-repair";
    const sessionId = "session-usage-repair";
    const orgId = "org-usage-repair";
    const receivedAt = Date.now();
    const input = {
      projectId,
      orgId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("repair-this-reservation"),
      t0: receivedAt,
      receivedAt,
    };

    await configureUsageReservationFailure({ projectId, sessionId, enabled: true });
    try {
      expect(await appendStatus(input)).toBe(500);
    } finally {
      await configureUsageReservationFailure({ projectId, sessionId, enabled: false });
    }

    expect(await readUsage(orgId)).toEqual([]);
    expect(await readDebug(projectId, sessionId)).toMatchObject({
      pendingBatches: 1,
      bufferedBytes: input.payload.byteLength,
    });

    await append(input);
    expect(await readUsage(orgId)).toMatchObject([{ sessions: 0, bytes: expect.any(Number) }]);
    expect(await readUsageLedger(projectId, sessionId)).not.toBeNull();
    expect(await readDebug(projectId, sessionId)).toMatchObject({
      pendingBatches: 1,
      bufferedBytes: input.payload.byteLength,
    });
  });

  it("dedupes batches by tab and seq", async () => {
    const projectId = "project-dedupe";
    const sessionId = "session-dedupe";
    const payloadA = bytes("payload-a");
    const payloadB = bytes("payload-b");
    const payloadC = bytes("payload-c");

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload: payloadA, t0: 1000 });
    await append({ projectId, sessionId, tab: "tab-b", seq: 0, payload: payloadB, t0: 1100 });
    await append({ projectId, sessionId, tab: "tab-a", seq: 1, payload: payloadC, t0: 1200 });
    await append({ projectId, sessionId, tab: "tab-a", seq: 1, payload: payloadC, t0: 1200 });

    const debug = await readDebug(projectId, sessionId);

    expect(debug).toEqual({
      hasState: true,
      schemaReady: true,
      finalized: false,
      firstRequestId: expect.any(String),
      bufferedBytes: payloadA.byteLength + payloadB.byteLength + payloadC.byteLength,
      pendingBatches: 3,
      segmentCount: 0,
      stateBytes: expect.any(Number),
    });
  });

  it("counts rejected first batches without creating session tables", async () => {
    const projectId = "project-rejected-rate-limit";
    const sessionId = "session-rejected-rate-limit";
    const receivedAt = Date.now();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await append({
        projectId,
        sessionId,
        tab: "tab-a",
        seq: 1,
        payload: bytes("out-of-order"),
        t0: receivedAt,
        receivedAt,
      });
      expect(result.closed).toBe(true);
      expect(result.rateLimited).toBeUndefined();
    }

    const limited = await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: bytes("out-of-order"),
      t0: receivedAt,
      receivedAt,
    });
    expect(limited).toMatchObject({ closed: false, rateLimited: true });
    expect(await readDebug(projectId, sessionId)).toMatchObject({
      hasState: false,
      schemaReady: false,
      pendingBatches: 0,
    });
  });

  it("dedupes an already flushed batch for the whole session", async () => {
    const projectId = "project-flushed-dedupe";
    const sessionId = "session-flushed-dedupe";
    const batches: AppendInput[] = [
      {
        projectId,
        sessionId,
        tab: "tab-a",
        seq: 0,
        payload: randomBytes(1500),
        t0: 2500,
        events: [{ t: 2501, k: "custom", d: "unique-0" }],
      },
      {
        projectId,
        sessionId,
        tab: "tab-a",
        seq: 1,
        payload: randomBytes(1500),
        t0: 2600,
        events: [{ t: 2601, k: "custom", d: "unique-1" }],
      },
      {
        projectId,
        sessionId,
        tab: "tab-b",
        seq: 0,
        payload: randomBytes(1500),
        t0: 2700,
        events: [{ t: 2701, k: "custom", d: "unique-2" }],
      },
    ];

    for (const batch of batches) {
      await append(batch);
    }

    const afterFlush = await readDebug(projectId, sessionId);
    expect(afterFlush.bufferedBytes).toBe(0);
    expect(afterFlush.pendingBatches).toBe(0);
    expect(afterFlush.segmentCount).toBe(1);

    const duplicate = batches[1];
    if (duplicate === undefined) {
      throw new Error("duplicate batch was not prepared");
    }

    await append(duplicate);

    const afterDuplicate = await readDebug(projectId, sessionId);
    expect(afterDuplicate.pendingBatches).toBe(afterFlush.pendingBatches);
    expect(afterDuplicate.bufferedBytes).toBe(afterFlush.bufferedBytes);
    expect(afterDuplicate.segmentCount).toBe(afterFlush.segmentCount);

    const manifestBytes = await waitForR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;

    expect(manifest.counts.batches).toBe(batches.length);
    expect(manifest.counts.events).toBe(batches.length);
    expect(manifest.timeline.map((event) => event.d)).toEqual(["unique-0", "unique-1", "unique-2"]);
  });

  it("uses server receive time for session bounds when client time is far in the future", async () => {
    const projectId = "project-server-time";
    const sessionId = "session-server-time";
    const receivedAt = Date.now();

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("future-time"),
      t0: receivedAt,
      t1: receivedAt + 5 * 365 * 24 * 60 * 60 * 1000,
      receivedAt,
    });
    await forceFinalize(projectId, sessionId);

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;

    expect(manifest.startedAt).toBe(receivedAt);
    expect(manifest.endedAt).toBe(receivedAt + 60_000);
    expect(manifest.durationMs).toBe(60_000);
  });

  it("reports the recorded span of a single-batch session instead of zero", async () => {
    const projectId = "project-recorded-span";
    const sessionId = "session-recorded-span";
    const receivedAt = Date.now();

    // A visitor recorded for 3 seconds whose only batch arrives at pagehide.
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("single-batch"),
      t0: receivedAt - 3_000,
      t1: receivedAt,
      receivedAt,
      checkpointTimestamps: [receivedAt - 3_000],
    });
    await forceFinalize(projectId, sessionId);

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;

    expect(manifest.startedAt).toBe(receivedAt - 3_000);
    expect(manifest.endedAt).toBe(receivedAt);
    expect(manifest.durationMs).toBe(3_000);
    expect(manifest.segments.flatMap((segment) => segment.checkpoints ?? [])).toHaveLength(1);
  });

  it("spans recorded time across multiple batches with delayed arrivals", async () => {
    const projectId = "project-multi-batch-span";
    const sessionId = "session-multi-batch-span";
    const receivedAt = Date.now();

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("b0"),
      t0: receivedAt - 9_000,
      t1: receivedAt - 8_200,
      receivedAt,
      checkpointTimestamps: [receivedAt - 9_000],
    });
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: bytes("b1"),
      t0: receivedAt - 6_000,
      t1: receivedAt - 5_000,
      receivedAt: receivedAt + 3_000,
    });
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 2,
      payload: bytes("b2"),
      t0: receivedAt - 2_000,
      t1: receivedAt + 500,
      receivedAt: receivedAt + 6_000,
    });
    await forceFinalize(projectId, sessionId);

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;

    expect(manifest.startedAt).toBe(receivedAt - 9_000);
    expect(manifest.endedAt).toBe(receivedAt + 500);
    expect(manifest.durationMs).toBe(9_500);
  });

  it("caps the recorded start so a skewed client cannot stretch the duration", async () => {
    const projectId = "project-lookback-cap";
    const sessionId = "session-lookback-cap";
    const receivedAt = Date.now();

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("skewed-start"),
      t0: receivedAt - 10 * 60_000,
      t1: receivedAt,
      receivedAt,
    });
    await forceFinalize(projectId, sessionId);

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;

    expect(manifest.startedAt).toBe(receivedAt - 5 * 60_000);
    expect(manifest.durationMs).toBe(5 * 60_000);
  });

  it("finalizes a checkpoint-less ghost batch with zero duration and no checkpoints", async () => {
    const projectId = "project-ghost";
    const sessionId = "session-ghost";
    const receivedAt = Date.now();

    // The Meta-only first flush of a bounced visit: one event timestamp, no
    // full snapshot. The session must finalize as confirmed unplayable.
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("meta-only"),
      t0: receivedAt - 4_000,
      t1: receivedAt - 4_000,
      receivedAt,
    });
    await forceFinalize(projectId, sessionId);

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;

    expect(manifest.durationMs).toBe(0);
    expect(manifest.segments).toHaveLength(1);
    expect(manifest.segments.flatMap((segment) => segment.checkpoints ?? [])).toHaveLength(0);
  });

  it("keeps state small when many navigations are recorded", async () => {
    const projectId = "project-small-state";
    const sessionId = "session-small-state";

    const debug = await seedBatches({
      projectId,
      sessionId,
      tab: "tab-a",
      startSeq: 0,
      count: 1500,
      payloadBytes: 0,
      t0: 9000,
    });

    expect(debug.hasState).toBe(true);
    expect(debug.stateBytes).toBeLessThan(1000);
  });

  it("writes the per-tab page count into the finalized manifest", async () => {
    const projectId = "project-page-count";
    const sessionId = "session-page-count";
    const payload = bytes("page-count");

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload,
      t0: 10_000,
      url: "/a",
      events: [{ t: 10_001, k: "vital", d: "navigation" }],
    });
    await append({ projectId, sessionId, tab: "tab-a", seq: 1, payload, t0: 10_100, url: "/a" });
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 2,
      payload,
      t0: 10_200,
      url: "/a",
      events: [{ t: 10_201, k: "vital", d: "navigation" }],
    });
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 3,
      payload,
      t0: 10_300,
      url: "/b",
      events: [{ t: 10_301, k: "nav", d: "/b" }],
    });
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 4,
      payload,
      t0: 10_400,
      url: "/a",
      events: [{ t: 10_401, k: "nav", d: "/a" }],
    });
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 5,
      payload,
      t0: 10_500,
      url: "/a",
      events: [{ t: 10_501, k: "nav", d: "/a" }],
    });
    await append({
      projectId,
      sessionId,
      tab: "tab-b",
      seq: 0,
      payload,
      t0: 10_600,
      url: "/tab-b",
      events: [{ t: 10_601, k: "vital", d: "navigation" }],
    });
    await append({ projectId, sessionId, tab: "tab-a", seq: 6, payload, t0: 10_700, url: "/a" });
    await append({
      projectId,
      sessionId,
      tab: "tab-b",
      seq: 1,
      payload,
      t0: 10_800,
      url: "/tab-b",
    });

    await forceFinalize(projectId, sessionId);
    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;

    expect(manifest.attrs.pageCount).toBe(5);
    expect(manifest.attrs.urlCount).toBe(4);
  });

  it("keeps legacy page fields absent when a pre-deploy session finalizes", async () => {
    const projectId = "project-legacy-page-count";
    const sessionId = "session-legacy-page-count";

    await seedBatches({
      projectId,
      sessionId,
      tab: "tab-a",
      startSeq: 0,
      count: 1,
      payloadBytes: 1,
      t0: Date.now(),
      analyticsVersion: 0,
    });
    await forceFinalize(projectId, sessionId);

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;
    expect(manifest.attrs.pageCount).toBeUndefined();
  });

  it("writes every stored event into the finalized analytics sidecar", async () => {
    const projectId = "project-complete-sidecar";
    const sessionId = "session-complete-sidecar";

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("first"),
      t0: 20_000,
      events: [
        { t: 20_001, k: "custom", d: "first stored event" },
        { t: 20_002, k: "error", d: "stored error" },
      ],
    });
    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: bytes("second"),
      t0: 20_100,
      events: [{ t: 20_101, k: "nav", d: "/next" }],
    });

    await forceFinalize(projectId, sessionId);
    const sidecarBytes = await readR2Bytes(analyticsSidecarKey(projectId, sessionId));
    const lines = new TextDecoder()
      .decode(sidecarBytes)
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines[0]).toEqual({ v: 1, coverage: "complete" });
    expect(lines.slice(1).map((line) => line["event_detail"])).toEqual([
      "first stored event",
      "stored error",
      "/next",
    ]);
    expect(lines.slice(1).map((line) => line["event_index"])).toEqual([0, 1, 2]);
  });
});
