import { describe, expect, it } from "vite-plus/test";
import { MAX_BATCHES_PER_SEGMENT } from "@orange-replay/shared";
import {
  chunkForSegments,
  clampIndexForStorage,
  shouldDropForSessionCap,
} from "../src/do/session-logic.ts";

describe("SessionRecorder pure logic", () => {
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

  it("includes encoded batch and ORS header bytes when chunking segments", () => {
    const rows = [{ bytes: 40 }, { bytes: 40 }, { bytes: 40 }];

    const chunks = chunkForSegments(rows, {
      maxEncodedSegmentBytes: 100,
      readBatchBytes: (row) => row.bytes,
    });

    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 1]);
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

  it("stores whole millisecond times for analytics export", () => {
    const clamped = clampIndexForStorage(
      {
        v: 1,
        s: "session",
        tab: "tab",
        seq: 0,
        t0: 1_000.9,
        t1: 1_100.8,
        e: [{ t: 1_050.7, k: "custom" }],
        checkpointTimestamps: [1_025.6],
      },
      1_000,
      1_200,
    );

    expect(clamped).toMatchObject({
      t0: 1_000,
      t1: 1_100,
      e: [{ t: 1_050, k: "custom" }],
      checkpointTimestamps: [1_025],
    });
  });

  it("drops new batches when the per-session caps are reached", () => {
    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 512 * 1024 * 1024,
        totalEventBytes: 0,
        batchCount: 1,
        segmentCount: 0,
        payloadBytes: 1,
        eventBytes: 0,
      }),
    ).toBe(true);

    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 10,
        totalEventBytes: 0,
        batchCount: 10_000_000,
        segmentCount: 0,
        payloadBytes: 1,
        eventBytes: 0,
      }),
    ).toBe(true);

    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 10,
        totalEventBytes: 64 * 1024 * 1024,
        batchCount: 1,
        segmentCount: 0,
        payloadBytes: 1,
        eventBytes: 1,
      }),
    ).toBe(true);

    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 512 * 1024 * 1024 - 20,
        totalEventBytes: 10,
        batchCount: 1,
        segmentCount: 0,
        payloadBytes: 9,
        eventBytes: 2,
      }),
    ).toBe(true);

    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 10,
        totalEventBytes: 10,
        batchCount: 1,
        segmentCount: 10_000,
        payloadBytes: 1,
        eventBytes: 1,
      }),
    ).toBe(true);

    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 10,
        totalEventBytes: 10,
        batchCount: 1,
        segmentCount: 0,
        payloadBytes: 1,
        eventBytes: 1,
      }),
    ).toBe(false);

    expect(
      shouldDropForSessionCap({
        totalPayloadBytes: 10,
        totalEventBytes: 10,
        batchCount: 50_000,
        segmentCount: 0,
        payloadBytes: 1,
        eventBytes: 1,
      }),
    ).toBe(true);
  });
});
