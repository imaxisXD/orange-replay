import {
  buildSegment,
  encodedIngestBodyByteLength,
  encodeIngestBody,
  manifestKey,
  MAX_CHECKPOINTS_PER_SEGMENT,
  MAX_MANIFEST_SEGMENTS,
  segmentKey,
} from "@orange-replay/shared";
import type { AppendArgs } from "./contract.ts";
import type { BatchRow, SegmentIntent, StoredBatchInput } from "./session-recorder-store.ts";
import { SessionRecorderStore } from "./session-recorder-store.ts";
import { encodeStoredSegmentMetadata, parseStoredBatchMetadata } from "./session-batch-metadata.ts";
import {
  capTimelineEventsToBudget,
  chunkForSegments,
  MAX_MANIFEST_TIMELINE_EVENTS,
  MAX_SEGMENT_INTENT_BODY_BYTES,
} from "./session-budgets.ts";
import type { SessionState } from "./session-state.ts";
import type { SegmentFlushReason } from "./session-timing.ts";

export interface SegmentFlushResult {
  reason: SegmentFlushReason;
  bytes: number;
  batches: number;
}

export class SessionSegmentWriter {
  constructor(
    private readonly store: SessionRecorderStore,
    private readonly recordings: R2Bucket,
  ) {}

  async recordingExists(projectId: string, sessionId: string): Promise<boolean> {
    const manifest = await this.recordings.head(manifestKey(projectId, sessionId));
    if (manifest !== null) {
      return true;
    }

    return (await this.recordings.head(segmentKey(projectId, sessionId, 1))) !== null;
  }

  async assertRecordingMatches(key: string, expected: Uint8Array): Promise<void> {
    const expectedBody = new Response(expected).body;
    if (expectedBody === null) {
      throw new Error(`Could not create the expected R2 body: ${key}`);
    }
    await this.assertRecordingStreamMatches(key, expectedBody, expected.byteLength);
  }

  async assertRecordingStreamMatches(
    key: string,
    expected: ReadableStream<Uint8Array>,
    expectedLength: number,
  ): Promise<void> {
    const existing = await this.recordings.get(key);
    if (existing === null) {
      await cancelQuietly(expected);
      throw new Error(`R2 create-only write was not confirmed: ${key}`);
    }
    if (existing.size !== expectedLength) {
      await Promise.all([cancelQuietly(existing.body), cancelQuietly(expected)]);
      throw new Error(`R2 create-only write does not match expected object: ${key}`);
    }
    if (!(await byteStreamsEqual(existing.body, expected))) {
      throw new Error(`R2 create-only write does not match expected object: ${key}`);
    }
  }

  hasCapacityForBatch(state: SessionState, candidate: StoredBatchInput): boolean {
    const pendingIntent = this.store.pendingSegmentIntent();
    const intentRows = new Set(
      (pendingIntent?.rows ?? []).map((row) => `${row.tab}\u0000${String(row.seq)}`),
    );
    const pendingRows = this.store
      .pendingBatchRows()
      .filter(
        (row) =>
          row.bytes > 0 &&
          row.body.byteLength > 0 &&
          !intentRows.has(`${row.tab}\u0000${String(row.seq)}`),
      );
    const rows = (
      candidate.bytes > 0 && candidate.body.byteLength > 0
        ? [...pendingRows, candidate]
        : pendingRows
    ).toSorted(
      (left, right) =>
        left.t0 - right.t0 || left.tab.localeCompare(right.tab) || left.seq - right.seq,
    );
    const requiredSegments = chunkForSegments(rows, {
      maxEncodedSegmentBytes: MAX_SEGMENT_INTENT_BODY_BYTES,
      readBatchBytes: (row) => encodedSegmentBatchBytes(state.sessionId, row),
    }).length;
    const reservedThrough = Math.max(
      state.segmentCount,
      this.store.maxSegmentNumber(),
      pendingIntent?.n ?? 0,
    );
    return reservedThrough + requiredSegments <= MAX_MANIFEST_SEGMENTS;
  }

  async flushSegment(
    state: SessionState,
    reason: SegmentFlushReason,
  ): Promise<SegmentFlushResult | null> {
    const recoveredSegmentCount = this.store.maxSegmentNumber();
    if (recoveredSegmentCount > state.segmentCount) {
      state.segmentCount = recoveredSegmentCount;
      this.store.persistState(state);
    }

    let totalSegmentBytes = 0;
    let totalBatches = 0;
    const pendingIntent = this.store.pendingSegmentIntent();
    if (pendingIntent !== null) {
      await this.completeSegmentIntent(state, pendingIntent);
      totalSegmentBytes += pendingIntent.bytes;
      totalBatches += pendingIntent.batches;
    }

    const rows = this.store.pendingBatchRows();
    if (rows.length === 0) {
      return totalBatches === 0
        ? null
        : { reason, bytes: totalSegmentBytes, batches: totalBatches };
    }

    const emptyRows = rows.filter((row) => row.bytes === 0 || row.body.byteLength === 0);
    const segmentRows = rows.filter((row) => row.bytes > 0 && row.body.byteLength > 0);

    for (const row of emptyRows) {
      this.store.markBatchBodyFlushed(row.tab, row.seq);
    }

    if (emptyRows.length > 0) {
      state.bufferedBytes = this.store.pendingBatchBytes();
      state.lastFlushAt = Date.now();
      this.store.persistState(state);
    }

    if (segmentRows.length === 0) {
      return totalBatches === 0
        ? null
        : { reason, bytes: totalSegmentBytes, batches: totalBatches };
    }

    for (const chunk of chunkForSegments(segmentRows, {
      maxEncodedSegmentBytes: MAX_SEGMENT_INTENT_BODY_BYTES,
      readBatchBytes: (row) => {
        const metadata = parseStoredBatchMetadata(row.events);
        return encodedIngestBodyByteLength(
          batchIndexForSegmentRow(state.sessionId, row, metadata),
          row.body.byteLength,
        );
      },
    })) {
      if (state.segmentCount >= MAX_MANIFEST_SEGMENTS) {
        throw new Error("Accepted replay data exceeds the manifest segment limit.");
      }

      const batchMetadata = chunk.map((row) => parseStoredBatchMetadata(row.events));
      const bodies = chunk.map((row, batchIndex) =>
        encodeIngestBody(
          batchIndexForSegmentRow(state.sessionId, row, batchMetadata[batchIndex]),
          new Uint8Array(row.body),
        ),
      );
      const bodyBytes = chunk.reduce((total, row) => total + row.bytes, 0);
      const segment = buildSegment(bodies);
      const events = capTimelineEventsToBudget(
        batchMetadata
          .flatMap((metadata) => metadata.events)
          .toSorted((left, right) => left.t - right.t),
        MAX_MANIFEST_TIMELINE_EVENTS,
      );
      const checkpoints = batchMetadata
        .flatMap((metadata, batch) => {
          const row = chunk[batch];
          if (row === undefined) {
            return [];
          }
          return metadata.checkpointTimestamps.map((timestamp) => ({
            timestamp,
            tab: row.tab,
            batch,
          }));
        })
        .toSorted((left, right) => left.timestamp - right.timestamp || left.batch - right.batch)
        .slice(0, MAX_CHECKPOINTS_PER_SEGMENT);
      const nextSegmentNumber = state.segmentCount + 1;
      const key = segmentKey(state.projectId, state.sessionId, nextSegmentNumber);
      const t0 = Math.min(...chunk.map((row) => row.t0));
      const t1 = Math.max(...chunk.map((row) => row.t1));
      const intent: SegmentIntent = {
        n: nextSegmentNumber,
        key,
        bytes: segment.byteLength,
        t0,
        t1,
        batches: chunk.length,
        events: encodeStoredSegmentMetadata(events, checkpoints),
        rows: chunk.map((row) => ({ tab: row.tab, seq: row.seq })),
        body: segment,
        batchBytes: bodyBytes,
      };

      this.store.persistSegmentIntent(intent);
      await this.completeSegmentIntent(state, intent);
      totalSegmentBytes += intent.bytes;
      totalBatches += intent.batches;
    }

    return { reason, bytes: totalSegmentBytes, batches: totalBatches };
  }

  private async completeSegmentIntent(state: SessionState, intent: SegmentIntent): Promise<void> {
    const written = await this.recordings.put(intent.key, intent.body, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (written === null) {
      await this.assertRecordingMatches(intent.key, intent.body);
    }

    this.store.upsertSegment(intent);

    for (const row of intent.rows) {
      this.store.markBatchBodyFlushed(row.tab, row.seq);
    }

    state.bufferedBytes = this.store.pendingBatchBytes();
    state.segmentCount = Math.max(state.segmentCount, intent.n);
    state.lastFlushAt = Date.now();
    this.store.persistState(state);
    this.store.deleteSegmentIntent(intent.n);
  }
}

function batchIndexForSegmentRow(
  sessionId: string,
  row: Pick<BatchRow, "tab" | "seq" | "t0" | "t1" | "events"> | StoredBatchInput,
  metadata = parseStoredBatchMetadata(row.events),
): AppendArgs["index"] {
  return {
    v: 1,
    s: sessionId,
    tab: row.tab,
    seq: row.seq,
    t0: row.t0,
    t1: row.t1,
    e: metadata.events,
    ...(metadata.checkpointTimestamps.length > 0
      ? { checkpointTimestamps: metadata.checkpointTimestamps }
      : {}),
  };
}

function encodedSegmentBatchBytes(
  sessionId: string,
  row: Pick<BatchRow, "tab" | "seq" | "t0" | "t1" | "events" | "body"> | StoredBatchInput,
): number {
  const metadata = parseStoredBatchMetadata(row.events);
  return encodedIngestBodyByteLength(
    batchIndexForSegmentRow(sessionId, row, metadata),
    row.body.byteLength,
  );
}

async function byteStreamsEqual(
  left: ReadableStream<Uint8Array>,
  right: ReadableStream<Uint8Array>,
): Promise<boolean> {
  const leftReader = left.getReader();
  const rightReader = right.getReader();
  let leftChunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let rightChunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let leftOffset = 0;
  let rightOffset = 0;
  let leftDone = false;
  let rightDone = false;

  try {
    for (;;) {
      while (!leftDone && leftOffset === leftChunk.byteLength) {
        const next = await leftReader.read();
        leftDone = next.done;
        leftChunk = next.value ?? new Uint8Array(0);
        leftOffset = 0;
      }
      while (!rightDone && rightOffset === rightChunk.byteLength) {
        const next = await rightReader.read();
        rightDone = next.done;
        rightChunk = next.value ?? new Uint8Array(0);
        rightOffset = 0;
      }

      if (leftDone || rightDone) return leftDone && rightDone;

      const bytesToCompare = Math.min(
        leftChunk.byteLength - leftOffset,
        rightChunk.byteLength - rightOffset,
      );
      for (let index = 0; index < bytesToCompare; index += 1) {
        if (leftChunk[leftOffset + index] !== rightChunk[rightOffset + index]) return false;
      }
      leftOffset += bytesToCompare;
      rightOffset += bytesToCompare;
    }
  } finally {
    await Promise.all([
      leftDone ? Promise.resolve() : leftReader.cancel().catch(() => undefined),
      rightDone ? Promise.resolve() : rightReader.cancel().catch(() => undefined),
    ]);
    leftReader.releaseLock();
    rightReader.releaseLock();
  }
}

async function cancelQuietly(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await stream.cancel();
  } catch {
    // The create-only mismatch is the useful error.
  }
}
