import { MAX_MANIFEST_SEGMENTS } from "@orange-replay/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  BatchRow,
  SessionRecorderStore,
  StoredBatchInput,
} from "../src/do/session-recorder-store.ts";
import { SessionSegmentWriter } from "../src/do/session-segment-writer.ts";
import type { SessionState } from "../src/do/session-state.ts";

describe("R2 create-only conflict checks", () => {
  it("compares a large sidecar as streams without buffering either object", async () => {
    const byteLength = 12 * 1024 * 1024;
    const existing = patternStream(byteLength, 73_123);
    const bucket = {
      async get() {
        return {
          size: byteLength,
          body: existing,
          async arrayBuffer() {
            throw new Error("the full R2 object must not be buffered");
          },
        };
      },
    } as unknown as ConstructorParameters<typeof SessionSegmentWriter>[1];
    const writer = new SessionSegmentWriter({} as SessionRecorderStore, bucket);

    await expect(
      writer.assertRecordingStreamMatches(
        "p/project/session/analytics.ndjson",
        patternStream(byteLength, 31_337),
        byteLength,
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("rejects a same-size sidecar with different streamed bytes", async () => {
    const byteLength = 256 * 1024;
    const bucket = {
      async get() {
        return {
          size: byteLength,
          body: patternStream(byteLength, 8_191),
        };
      },
    } as unknown as ConstructorParameters<typeof SessionSegmentWriter>[1];
    const writer = new SessionSegmentWriter({} as SessionRecorderStore, bucket);

    await expect(
      writer.assertRecordingStreamMatches(
        "p/project/session/analytics.ndjson",
        patternStream(byteLength, 4_093, byteLength - 2),
        byteLength,
      ),
    ).rejects.toThrow("does not match expected object");
  });
});

describe("segment capacity", () => {
  it("rejects a batch when pending data needs more slots than remain", () => {
    const pendingRow = batchRow("old", 800_000);
    const store = {
      maxSegmentNumber: () => MAX_MANIFEST_SEGMENTS - 1,
      pendingBatchRows: () => [pendingRow],
      pendingSegmentIntent: () => null,
    } as unknown as SessionRecorderStore;
    const writer = new SessionSegmentWriter(
      store,
      {} as ConstructorParameters<typeof SessionSegmentWriter>[1],
    );
    const candidate: StoredBatchInput = {
      tab: "tab",
      seq: 2,
      t0: 2,
      t1: 2,
      bytes: 800_000,
      flags: 0,
      events: "[]",
      body: new Uint8Array(800_000),
    };

    expect(writer.hasCapacityForBatch(sessionState(MAX_MANIFEST_SEGMENTS - 1), candidate)).toBe(
      false,
    );
  });

  it("never clears an accepted batch when the segment invariant is violated", async () => {
    const markBatchBodyFlushed = vi.fn();
    const store = {
      maxSegmentNumber: () => MAX_MANIFEST_SEGMENTS,
      pendingBatchRows: () => [batchRow("kept", 10)],
      pendingSegmentIntent: () => null,
      markBatchBodyFlushed,
      pendingBatchBytes: () => 10,
      persistState: vi.fn(),
    } as unknown as SessionRecorderStore;
    const writer = new SessionSegmentWriter(
      store,
      {} as ConstructorParameters<typeof SessionSegmentWriter>[1],
    );

    await expect(
      writer.flushSegment(sessionState(MAX_MANIFEST_SEGMENTS), "tail_flush"),
    ).rejects.toThrow("exceeds the manifest segment limit");
    expect(markBatchBodyFlushed).not.toHaveBeenCalled();
  });
});

function batchRow(tab: string, bytes: number): BatchRow {
  return {
    tab,
    seq: 1,
    t0: 1,
    t1: 1,
    bytes,
    flags: 0,
    events: "[]",
    body: new Uint8Array(bytes).buffer,
  };
}

function sessionState(segmentCount: number): SessionState {
  return {
    projectId: "project",
    orgId: "org",
    shard: 0,
    retentionDays: 30,
    sessionId: "session",
    startedAt: 1,
    lastActivity: 1,
    lastFlushAt: 1,
    bufferedBytes: 0,
    totalPayloadBytes: 0,
    totalEventBytes: 0,
    batchCount: 0,
    segmentCount,
    flags: 0,
    attrs: {},
    firstRequestId: "request",
    urlCount: 0,
    analyticsVersion: 2,
    pageCount: 0,
    quickBacks: 0,
    pageTabs: [],
  };
}

function patternStream(
  totalBytes: number,
  chunkBytes: number,
  changedByteAt = -1,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= totalBytes) {
        controller.close();
        return;
      }
      const length = Math.min(chunkBytes, totalBytes - offset);
      const chunk = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        const absoluteIndex = offset + index;
        chunk[index] = absoluteIndex % 251;
        if (absoluteIndex === changedByteAt) chunk[index] = (chunk[index] ?? 0) ^ 1;
      }
      offset += length;
      controller.enqueue(chunk);
    },
  });
}
