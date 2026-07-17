import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { manifestKey, segmentKey } from "@orange-replay/shared";
import type { FinalizeMessage, SessionManifest } from "@orange-replay/shared";
import {
  append,
  bytes,
  forceFinalize,
  indexSessionNowForTest,
  markFinalizingForTest,
  readDebug,
  readR2Bytes,
  readUsageLedger,
  runAlarmForTest,
  seedDeletionMarker,
  waitForR2Bytes,
} from "./do-test-helpers.ts";

describe("SessionRecorder Durable Object", () => {
  it("finishes an alarm recovery after D1 indexed but before the tombstone was stored", async () => {
    const projectId = "project-alarm-indexed";
    const sessionId = "session-alarm-indexed";
    const orgId = "org-alarm-indexed";
    const base = Date.now();
    await append({
      projectId,
      orgId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("alarm-recovery"),
      t0: base,
      receivedAt: base,
    });
    await markFinalizingForTest(projectId, sessionId);

    const alreadyIndexedMessage: FinalizeMessage = {
      type: "session.finalized",
      projectId,
      orgId,
      sessionId,
      shard: 0,
      requestId: "request-alarm-indexed",
      manifestKey: manifestKey(projectId, sessionId),
      startedAt: base,
      endedAt: base + 50,
      durationMs: 50,
      hasCheckpoint: false,
      bytes: 65_536,
      segments: 1,
      flags: 0,
      analyticsVersion: 0,
      counts: { batches: 1, events: 1, clicks: 0, errors: 0, rages: 0, navs: 0 },
      attrs: { country: "US" },
      retentionDays: 7,
      events: [{ t: base + 1, k: "custom", d: "alarm-recovery" }],
    };
    await indexSessionNowForTest(alreadyIndexedMessage);
    expect(await readUsageLedger(projectId, sessionId)).toBeNull();

    await runAlarmForTest(projectId, sessionId);

    expect(await readDebug(projectId, sessionId)).toMatchObject({
      hasState: false,
      finalized: true,
    });
    expect(await readR2Bytes(manifestKey(projectId, sessionId))).not.toHaveLength(0);
  });

  it("finalizes an idle session into a manifest", async () => {
    const projectId = "project-finalize";
    const sessionId = "session-finalize";
    const payload = bytes("finalize-payload");
    // Timestamps must sit inside the server clamp window (A5), or they get
    // clamped to receive time and exact assertions break.
    const base = Date.now();

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload,
      t0: base,
      events: [
        { t: base + 10, k: "click" },
        { t: base + 20, k: "error", d: "failed" },
        { t: base + 30, k: "custom", d: "checkout" },
        { t: base + 40, k: "nav" },
      ],
    });

    const manifestBytes = await waitForR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;
    const debug = await readDebug(projectId, sessionId);

    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.projectId).toBe(projectId);
    expect(manifest.segments).toEqual([
      {
        key: segmentKey(projectId, sessionId, 1),
        bytes: expect.any(Number),
        t0: base,
        t1: base + 50,
        batches: 1,
      },
    ]);
    expect(manifest.counts).toEqual({
      batches: 1,
      events: 4,
      clicks: 1,
      errors: 1,
      rages: 0,
      navs: 1,
    });
    expect(manifest.timeline.map((event) => event.k)).toEqual(["click", "error", "custom", "nav"]);
    expect(debug.hasState).toBe(false);
    expect(debug.finalized).toBe(true);
  });

  it("returns closed for a late post-finalize batch", async () => {
    const projectId = "project-finalize";
    const sessionId = "session-finalize";

    const result = await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: bytes("late"),
      t0: 4000,
    });

    expect(result.closed).toBe(true);
    expect(result.live).toBe(false);
  });

  it("does not let a late seq-zero batch overwrite finalized R2 objects", async () => {
    const projectId = "project-finalize-immutable";
    const sessionId = "session-finalize-immutable";
    const payload = randomBytes(5000);

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload, t0: 4100 });
    await forceFinalize(projectId, sessionId);

    const segmentBefore = await readR2Bytes(segmentKey(projectId, sessionId, 1));
    const manifestBefore = await readR2Bytes(manifestKey(projectId, sessionId));
    const result = await append({
      projectId,
      sessionId,
      tab: "tab-late",
      seq: 0,
      payload: randomBytes(6000),
      t0: 4200,
    });
    const segmentAfter = await readR2Bytes(segmentKey(projectId, sessionId, 1));
    const manifestAfter = await readR2Bytes(manifestKey(projectId, sessionId));

    expect(result.closed).toBe(true);
    expect(Buffer.from(segmentAfter)).toEqual(Buffer.from(segmentBefore));
    expect(Buffer.from(manifestAfter)).toEqual(Buffer.from(manifestBefore));
  });

  it("keeps the finalized tombstone through the retention window", async () => {
    const projectId = "project-tombstone-retained";
    const sessionId = "session-tombstone-retained";

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("purge"),
      t0: 4300,
    });
    await forceFinalize(projectId, sessionId);

    const finalizedDebug = await readDebug(projectId, sessionId);
    expect(finalizedDebug.finalized).toBe(true);
    expect(finalizedDebug.tombstonePurgeAt).toBeGreaterThan(Date.now() + 86_400_000);

    const lateResult = await append({
      projectId,
      sessionId,
      tab: "tab-late",
      seq: 0,
      payload: bytes("late-reuse"),
      t0: 4400,
    });
    expect(lateResult.closed).toBe(true);
  });

  it("rejects a fresh session while a deletion marker exists", async () => {
    const projectId = "project-delete-fence";
    const sessionId = "session-delete-fence";

    await seedDeletionMarker(projectId, sessionId);
    const result = await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("blocked-by-marker"),
      t0: 4500,
    });

    expect(result.closed).toBe(true);
    expect(await readDebug(projectId, sessionId)).toMatchObject({
      finalized: false,
      hasState: false,
    });
  });
});
