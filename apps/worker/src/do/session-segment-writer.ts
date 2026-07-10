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
import type { BatchRow, SegmentIntent } from "./session-recorder-store.ts";
import { SessionRecorderStore } from "./session-recorder-store.ts";
import { encodeStoredSegmentMetadata, parseStoredBatchMetadata } from "./session-batch-metadata.ts";
import {
  capTimelineEventsToBudget,
  chunkForSegments,
  MAX_MANIFEST_TIMELINE_EVENTS,
  MAX_SEGMENT_INTENT_BODY_BYTES,
} from "./session-logic.ts";
import type { SegmentFlushReason, SessionState } from "./session-logic.ts";

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
    const existing = await this.recordings.get(key);
    if (existing === null) {
      throw new Error(`R2 create-only write was not confirmed: ${key}`);
    }
    const actual = new Uint8Array(await existing.arrayBuffer());
    if (!bytesEqual(actual, expected)) {
      throw new Error(`R2 create-only write does not match expected object: ${key}`);
    }
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
        for (const row of chunk) {
          this.store.markBatchBodyFlushed(row.tab, row.seq);
        }
        state.bufferedBytes = this.store.pendingBatchBytes();
        state.lastFlushAt = Date.now();
        this.store.persistState(state);
        continue;
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
  row: BatchRow,
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
