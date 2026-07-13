import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { analyticsSidecarKey, manifestKey } from "@orange-replay/shared";
import type { SessionManifest } from "@orange-replay/shared";
import {
  append,
  bytes,
  forceFinalize,
  readDebug,
  readR2Bytes,
  seedBatches,
  waitForR2Bytes,
} from "./do-test-helpers.ts";
import type { AppendInput } from "./do-test-helpers.ts";

describe("SessionRecorder Durable Object", () => {
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
      finalized: false,
      firstRequestId: expect.any(String),
      bufferedBytes: payloadA.byteLength + payloadB.byteLength + payloadC.byteLength,
      pendingBatches: 3,
      segmentCount: 0,
      stateBytes: expect.any(Number),
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
    expect(manifest.endedAt).toBeLessThanOrEqual(receivedAt + 60_000);
    expect(manifest.durationMs).toBeGreaterThanOrEqual(0);
    expect(manifest.durationMs).toBeLessThanOrEqual(60_000);
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
