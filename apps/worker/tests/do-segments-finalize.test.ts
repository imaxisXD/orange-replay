import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  decodeIngestBody,
  manifestKey,
  MAX_ENCODED_SEGMENT_BYTES,
  parseSegment,
  segmentBatch,
  segmentKey,
} from "@orange-replay/shared";
import type { SessionManifest } from "@orange-replay/shared";
import {
  append,
  bytes,
  flush,
  forceFinalize,
  readDebug,
  readManifestPayloads,
  readR2Bytes,
  seedBatches,
  waitForR2Bytes,
} from "./do-test-helpers.ts";

describe("SessionRecorder Durable Object", () => {
  it("flushes a segment when buffered bytes exceed the limit", async () => {
    const projectId = "project-size-flush";
    const sessionId = "session-size-flush";
    const payload = randomBytes(5000);

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload, t0: 2000 });

    const debug = await readDebug(projectId, sessionId);
    expect(debug.bufferedBytes).toBe(0);
    expect(debug.pendingBatches).toBe(0);
    expect(debug.segmentCount).toBe(1);

    const segmentBytes = await readR2Bytes(segmentKey(projectId, sessionId, 1));
    const parsed = parseSegment(segmentBytes);

    expect(parsed.count).toBe(1);
    expect(Buffer.from(decodeIngestBody(segmentBatch(parsed, 0)).payload)).toEqual(payload);
  });

  it("keeps gzip-like payload bytes unchanged", async () => {
    const projectId = "project-exact-bytes";
    const sessionId = "session-exact-bytes";
    const payload = randomBytes(6000);
    payload[0] = 0x1f;
    payload[1] = 0x8b;

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload, t0: 5000 });

    const segmentBytes = await readR2Bytes(segmentKey(projectId, sessionId, 1));
    const parsed = parseSegment(segmentBytes);

    expect(Buffer.from(decodeIngestBody(segmentBatch(parsed, 0)).payload)).toEqual(payload);
  });

  it("publishes full-snapshot checkpoints without reading replay payloads", async () => {
    const projectId = "project-checkpoints";
    const sessionId = "session-checkpoints";
    const recordedAt = Date.now();
    const checkpointTimestamp = recordedAt + 25;
    const payload = randomBytes(256);

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload,
      t0: recordedAt,
      t1: recordedAt + 50,
      checkpointTimestamps: [checkpointTimestamp],
    });
    await forceFinalize(projectId, sessionId);

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;
    expect(manifest.segments[0]?.checkpoints).toEqual([
      { timestamp: checkpointTimestamp, tab: "tab-a", batch: 0 },
    ]);

    const segment = parseSegment(await readR2Bytes(segmentKey(projectId, sessionId, 1)));
    const decoded = decodeIngestBody(segmentBatch(segment, 0));
    expect(decoded.index.checkpointTimestamps).toEqual([checkpointTimestamp]);
    expect(Buffer.from(decoded.payload)).toEqual(payload);
  });

  it("skips empty stored bodies so a poison row cannot wedge finalize", async () => {
    const projectId = "project-empty-poison";
    const sessionId = "session-empty-poison";
    const payload = bytes("valid-after-empty");

    await seedBatches({
      projectId,
      sessionId,
      tab: "tab-a",
      startSeq: 0,
      count: 1,
      payloadBytes: 0,
      t0: 6000,
    });
    await append({ projectId, sessionId, tab: "tab-a", seq: 1, payload, t0: 6010 });

    const manifestBytes = await waitForR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;
    const parsed = parseSegment(await readR2Bytes(segmentKey(projectId, sessionId, 1)));

    expect(manifest.counts.batches).toBe(1);
    expect(parsed.count).toBe(1);
    // hex-normalize: Buffer vs Uint8Array are structurally unequal to toEqual
    expect(Buffer.from(decodeIngestBody(segmentBatch(parsed, 0)).payload).toString("hex")).toBe(
      Buffer.from(payload).toString("hex"),
    );
  });

  it("flushes more than one max-sized chunk in a single snapshot", async () => {
    const projectId = "project-multi-chunk";
    const sessionId = "session-multi-chunk";
    const batchCount = 4097;

    await seedBatches({
      projectId,
      sessionId,
      tab: "tab-a",
      startSeq: 0,
      count: batchCount,
      payloadBytes: 1,
      t0: 7000,
    });
    const flushResult = await flush(projectId, sessionId);

    expect(flushResult?.batches).toBe(batchCount);

    const first = parseSegment(await readR2Bytes(segmentKey(projectId, sessionId, 1)));
    const second = parseSegment(await readR2Bytes(segmentKey(projectId, sessionId, 2)));
    const payloadValues: number[] = [];
    for (let index = 0; index < first.count; index += 1) {
      payloadValues.push(decodeIngestBody(segmentBatch(first, index)).payload[0] ?? 0);
    }
    for (let index = 0; index < second.count; index += 1) {
      payloadValues.push(decodeIngestBody(segmentBatch(second, index)).payload[0] ?? 0);
    }

    expect(first.count).toBe(4096);
    expect(second.count).toBe(1);
    expect(payloadValues).toEqual(
      Array.from({ length: batchCount }, (_, index) => (index % 251) + 1),
    );
  });

  it("keeps every stored segment within the player read limit", async () => {
    const projectId = "project-byte-chunks";
    const sessionId = "session-byte-chunks";
    const batchCount = 3;

    await seedBatches({
      projectId,
      sessionId,
      tab: "tab-a",
      startSeq: 0,
      count: batchCount,
      payloadBytes: 600 * 1024,
      t0: 7500,
    });
    const flushResult = await flush(projectId, sessionId);
    const firstBytes = await readR2Bytes(segmentKey(projectId, sessionId, 1));
    const secondBytes = await readR2Bytes(segmentKey(projectId, sessionId, 2));
    const first = parseSegment(firstBytes);
    const second = parseSegment(secondBytes);

    expect(flushResult?.batches).toBe(batchCount);
    expect(firstBytes.byteLength).toBeLessThanOrEqual(MAX_ENCODED_SEGMENT_BYTES);
    expect(secondBytes.byteLength).toBeLessThanOrEqual(MAX_ENCODED_SEGMENT_BYTES);
    expect(first.count + second.count).toBe(batchCount);
  });

  it("does not lose a batch that races with finalize", async () => {
    const projectId = "project-finalize-race";
    const sessionId = "session-finalize-race";
    const firstPayload = bytes("first");
    const racePayload = bytes("race");

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload: firstPayload, t0: 8000 });
    const finalizePromise = forceFinalize(projectId, sessionId);
    const appendPromise = append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: racePayload,
      t0: 8010,
    });
    const appendResult = await appendPromise;
    await finalizePromise;

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;
    const payloads = await readManifestPayloads(manifest);

    if (appendResult.closed) {
      expect(payloads).not.toContain(Buffer.from(racePayload).toString("hex"));
    } else {
      expect(payloads).toContain(Buffer.from(racePayload).toString("hex"));
    }
  });
});
