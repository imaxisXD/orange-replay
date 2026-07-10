import type { EdgeAttrs, SegmentRef } from "@orange-replay/shared";
import {
  clampIndexForStorage,
  createFreshState,
  encodedTextBytes,
  normalizeSessionState,
  updateStateWithBatch,
} from "./session-logic.ts";
import type { SegmentForManifest, SessionState } from "./session-logic.ts";
import { encodeStoredBatchMetadata, parseStoredSegmentMetadata } from "./session-batch-metadata.ts";

type SqlRowValue = ArrayBuffer | string | number | null;

interface StateRow {
  [key: string]: SqlRowValue;
  v: string;
}

export interface BatchRow {
  [key: string]: SqlRowValue;
  tab: string;
  seq: number;
  t0: number;
  t1: number;
  bytes: number;
  flags: number;
  events: string;
  body: ArrayBuffer;
}

interface CountRow {
  [key: string]: SqlRowValue;
  count: number;
}

export interface StoredEventRow {
  [key: string]: SqlRowValue;
  events: string;
}

export interface SegmentRow {
  [key: string]: SqlRowValue;
  n: number;
  key: string;
  bytes: number;
  t0: number;
  t1: number;
  batches: number;
  events: string;
}

interface SegmentManifestRow {
  [key: string]: SqlRowValue;
  key: string;
  bytes: number;
  t0: number;
  t1: number;
  batches: number;
  events: string;
}

interface SegmentIntentRow extends SegmentRow {
  rows_json: string;
  body: ArrayBuffer;
  batch_bytes: number;
}

export interface SegmentIntentBatchRef {
  tab: string;
  seq: number;
}

export interface SegmentIntent {
  n: number;
  key: string;
  bytes: number;
  t0: number;
  t1: number;
  batches: number;
  events: string;
  rows: SegmentIntentBatchRef[];
  body: Uint8Array;
  batchBytes: number;
}

export interface FinalizedTombstone {
  finalized: true;
  finalizedAt: number;
  purgeAt: number;
  firstRequestId: string;
  projectId?: string;
  orgId?: string;
  sessionId?: string;
}

export interface StoredSessionState {
  state: SessionState | null;
  tombstone: FinalizedTombstone | null;
}

export interface StoredBatchInput {
  tab: string;
  seq: number;
  t0: number;
  t1: number;
  bytes: number;
  flags: number;
  events: string;
  body: Uint8Array;
}

export interface TestSeedBatchesArgs {
  requestId: string;
  projectId: string;
  orgId: string;
  shard: number;
  retentionDays: number;
  sessionId: string;
  tab: string;
  startSeq: number;
  count: number;
  payloadBytes: number;
  t0: number;
  receivedAt: number;
  flags: number;
  attrs: EdgeAttrs;
  analyticsVersion?: number;
}

export class SessionRecorderStore {
  constructor(private readonly sql: SqlStorage) {}

  createSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id=1),
        v TEXT
      );
      CREATE TABLE IF NOT EXISTS batches (
        tab TEXT,
        seq INTEGER,
        t0 INTEGER,
        t1 INTEGER,
        bytes INTEGER,
        flags INTEGER,
        events TEXT,
        body BLOB,
        PRIMARY KEY (tab, seq)
      );
      CREATE TABLE IF NOT EXISTS segments (
        n INTEGER PRIMARY KEY,
        key TEXT,
        bytes INTEGER,
        t0 INTEGER,
        t1 INTEGER,
        batches INTEGER,
        events TEXT
      );
      CREATE TABLE IF NOT EXISTS segment_intents (
        n INTEGER PRIMARY KEY,
        key TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        t0 INTEGER NOT NULL,
        t1 INTEGER NOT NULL,
        batches INTEGER NOT NULL,
        events TEXT NOT NULL,
        rows_json TEXT NOT NULL,
        body BLOB NOT NULL,
        batch_bytes INTEGER NOT NULL
      );
    `);
  }

  loadStoredState(): StoredSessionState {
    const row = this.sql.exec<StateRow>("SELECT v FROM state WHERE id = 1").toArray()[0];
    if (row === undefined) {
      return { state: null, tombstone: null };
    }

    const parsed = JSON.parse(row.v) as unknown;
    if (isFinalizedTombstone(parsed)) {
      return { state: null, tombstone: normalizeFinalizedTombstone(parsed) };
    }

    return { state: normalizeSessionState(parsed as SessionState), tombstone: null };
  }

  persistState(state: SessionState): void {
    this.sql.exec(
      `INSERT INTO state (id, v)
        VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET v = excluded.v`,
      JSON.stringify(state),
    );
  }

  pendingBatchCount(): number {
    return this.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM batches WHERE body IS NOT NULL")
      .one().count;
  }

  pendingBatchBytes(): number {
    return this.sql
      .exec<CountRow>("SELECT COALESCE(SUM(bytes), 0) AS count FROM batches WHERE body IS NOT NULL")
      .one().count;
  }

  batchExists(tab: string, seq: number): boolean {
    return (
      this.sql
        .exec<CountRow>("SELECT COUNT(*) AS count FROM batches WHERE tab = ? AND seq = ?", tab, seq)
        .one().count > 0
    );
  }

  insertBatch(batch: StoredBatchInput): boolean {
    const insert = this.sql.exec(
      `INSERT OR IGNORE INTO batches
          (tab, seq, t0, t1, bytes, flags, events, body)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      batch.tab,
      batch.seq,
      batch.t0,
      batch.t1,
      batch.bytes,
      batch.flags,
      batch.events,
      exactArrayBuffer(batch.body),
    );
    return insert.rowsWritten > 0;
  }

  seedBatchesForTest(currentState: SessionState | null, args: TestSeedBatchesArgs): SessionState {
    let state = currentState;
    if (state === null) {
      state = createFreshState({
        ...args,
        seq: args.startSeq,
        index: testIndex(args.sessionId, args.tab, args.startSeq, args.t0),
        payload: makeTestPayload(args.payloadBytes, args.startSeq),
      });
    }
    if (args.analyticsVersion !== undefined) {
      state.analyticsVersion = args.analyticsVersion;
    }

    for (let offset = 0; offset < args.count; offset += 1) {
      const seq = args.startSeq + offset;
      if (this.batchExists(args.tab, seq)) {
        continue;
      }

      const payload = makeTestPayload(args.payloadBytes, seq);
      const index = clampIndexForStorage(
        testIndex(args.sessionId, args.tab, seq, args.t0 + offset),
        state.startedAt,
        args.receivedAt,
      );
      const eventsJson = encodeStoredBatchMetadata(index);

      this.insertBatch({
        tab: args.tab,
        seq,
        t0: index.t0,
        t1: index.t1,
        bytes: payload.byteLength,
        flags: args.flags,
        events: eventsJson,
        body: payload,
      });

      updateStateWithBatch(
        state,
        { ...args, seq, index, payload },
        index,
        encodedTextBytes(eventsJson),
      );
    }

    this.persistState(state);
    return state;
  }

  pendingBatchRows(): BatchRow[] {
    return this.sql
      .exec<BatchRow>(
        `SELECT tab, seq, t0, t1, bytes, flags, events, body
          FROM batches
          WHERE body IS NOT NULL
          ORDER BY t0, tab, seq`,
      )
      .toArray();
  }

  storedEventRows(): Iterable<StoredEventRow> {
    return this.sql.exec<StoredEventRow>("SELECT events FROM batches ORDER BY t0, tab, seq");
  }

  segmentRows(): SegmentRow[] {
    return this.sql
      .exec<SegmentRow>("SELECT n, key, bytes, t0, t1, batches, events FROM segments ORDER BY n")
      .toArray();
  }

  maxSegmentNumber(): number {
    const row = this.sql
      .exec<CountRow>("SELECT COALESCE(MAX(n), 0) AS count FROM segments")
      .toArray()[0];
    return row?.count ?? 0;
  }

  pendingSegmentIntent(): SegmentIntent | null {
    const row = this.sql
      .exec<SegmentIntentRow>(
        `SELECT n, key, bytes, t0, t1, batches, events, rows_json, body, batch_bytes
          FROM segment_intents
          ORDER BY n
          LIMIT 1`,
      )
      .toArray()[0];
    if (row === undefined) {
      return null;
    }

    return {
      n: row.n,
      key: row.key,
      bytes: row.bytes,
      t0: row.t0,
      t1: row.t1,
      batches: row.batches,
      events: row.events,
      rows: parseSegmentIntentRows(row.rows_json),
      body: new Uint8Array(row.body),
      batchBytes: row.batch_bytes,
    };
  }

  segmentRefs(): SegmentRef[] {
    return this.segmentRows().map((row) => {
      const metadata = parseStoredSegmentMetadata(row.events);
      return {
        key: row.key,
        bytes: row.bytes,
        t0: row.t0,
        t1: row.t1,
        batches: row.batches,
        ...(metadata.checkpoints.length > 0 ? { checkpoints: metadata.checkpoints } : {}),
      };
    });
  }

  persistSegmentIntent(intent: SegmentIntent): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO segment_intents
        (n, key, bytes, t0, t1, batches, events, rows_json, body, batch_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      intent.n,
      intent.key,
      intent.bytes,
      intent.t0,
      intent.t1,
      intent.batches,
      intent.events,
      JSON.stringify(intent.rows),
      exactArrayBuffer(intent.body),
      intent.batchBytes,
    );
  }

  markBatchBodyFlushed(tab: string, seq: number): void {
    this.sql.exec(
      "UPDATE batches SET body = NULL WHERE tab = ? AND seq = ? AND body IS NOT NULL",
      tab,
      seq,
    );
  }

  upsertSegment(intent: SegmentIntent): void {
    this.sql.exec(
      `INSERT INTO segments (n, key, bytes, t0, t1, batches, events)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(n) DO UPDATE SET
          key = excluded.key,
          bytes = excluded.bytes,
          t0 = excluded.t0,
          t1 = excluded.t1,
          batches = excluded.batches,
          events = excluded.events`,
      intent.n,
      intent.key,
      intent.bytes,
      intent.t0,
      intent.t1,
      intent.batches,
      intent.events,
    );
  }

  deleteSegmentIntent(segmentNumber: number): void {
    this.sql.exec("DELETE FROM segment_intents WHERE n = ?", segmentNumber);
  }

  segmentRowsForManifest(): SegmentForManifest[] {
    return this.sql
      .exec<SegmentManifestRow>(
        "SELECT key, bytes, t0, t1, batches, events FROM segments ORDER BY n",
      )
      .toArray()
      .map((row) => {
        const metadata = parseStoredSegmentMetadata(row.events);
        return {
          key: row.key,
          bytes: row.bytes,
          t0: row.t0,
          t1: row.t1,
          batches: row.batches,
          ...(metadata.checkpoints.length > 0 ? { checkpoints: metadata.checkpoints } : {}),
          events: [],
        };
      });
  }

  replaceStateWithTombstone(tombstone: FinalizedTombstone): void {
    this.sql.exec("DELETE FROM batches");
    this.sql.exec("DELETE FROM segments");
    this.sql.exec("DELETE FROM segment_intents");
    this.sql.exec("DELETE FROM state");
    this.sql.exec("INSERT INTO state (id, v) VALUES (1, ?)", JSON.stringify(tombstone));
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function testIndex(sessionId: string, tab: string, seq: number, t0: number) {
  return {
    v: 1 as const,
    s: sessionId,
    tab,
    seq,
    t0,
    t1: t0 + 1,
    u: `/seed-${seq}`,
    e: [{ t: t0, k: "custom" as const, d: `seed-${seq}` }],
  };
}

function makeTestPayload(size: number, seq: number): Uint8Array {
  const payload = new Uint8Array(Math.max(0, size));
  payload.fill((seq % 251) + 1);
  return payload;
}

function parseSegmentIntentRows(raw: string): SegmentIntentBatchRef[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("segment intent rows are invalid");
  }

  return parsed.map((value) => {
    if (!isSegmentIntentBatchRef(value)) {
      throw new Error("segment intent rows are invalid");
    }

    return { tab: value.tab, seq: value.seq };
  });
}

function isSegmentIntentBatchRef(value: unknown): value is SegmentIntentBatchRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record["tab"] === "string" &&
    record["tab"].length > 0 &&
    Number.isSafeInteger(record["seq"]) &&
    typeof record["seq"] === "number" &&
    record["seq"] >= 0
  );
}

function isFinalizedTombstone(value: unknown): value is FinalizedTombstone {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate["finalized"] === true &&
    typeof candidate["finalizedAt"] === "number" &&
    Number.isFinite(candidate["finalizedAt"]) &&
    typeof candidate["firstRequestId"] === "string"
  );
}

function normalizeFinalizedTombstone(value: FinalizedTombstone): FinalizedTombstone {
  if (typeof value.purgeAt === "number" && Number.isFinite(value.purgeAt)) {
    return value;
  }

  return {
    ...value,
    purgeAt: value.finalizedAt + 86_400_000,
  };
}
