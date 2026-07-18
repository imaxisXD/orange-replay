import { MAX_MANIFEST_SEGMENTS } from "@orange-replay/shared";
import type { EdgeAttrs, SegmentCheckpoint, SegmentRef } from "@orange-replay/shared";
import { clampIndexForStorage } from "./session-budgets.ts";
import {
  createFreshState,
  encodedTextBytes,
  normalizeSessionState,
  updateStateWithBatch,
} from "./session-state.ts";
import type { SegmentForManifest } from "./session-manifest.ts";
import type { SessionState } from "./session-state.ts";
import {
  encodeStoredBatchMetadata,
  parseStoredBatchMetadata,
  parseStoredSegmentCheckpoints,
  parseStoredSegmentMetadata,
} from "./session-batch-metadata.ts";
import type { StoredPageBatch } from "./session-page-tracking.ts";

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

interface PagedStoredEventRow extends StoredEventRow {
  t0: number;
  tab: string;
  seq: number;
}

interface StoredPageBatchRow extends StoredEventRow {
  tab: string;
  seq: number;
  t0: number;
  t1: number;
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
  n: number;
  key: string;
  bytes: number;
  t0: number;
  t1: number;
  batches: number;
  has_checkpoint: number;
  checkpoints: string;
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

const FINALIZE_METADATA_PAGE_SIZE = 50;
export const MAX_MANIFEST_TOTAL_CHECKPOINTS = 2_048;

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

  hasSchema(): boolean {
    return (
      this.sql
        .exec<CountRow>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'state'",
        )
        .one().count > 0
    );
  }

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
      CREATE TABLE IF NOT EXISTS used_live_tickets (
        nonce TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  consumeLiveTicket(nonce: string, expiresAt: number, now: number): boolean {
    this.sql.exec("DELETE FROM used_live_tickets WHERE expires_at <= ?", now);
    return (
      this.sql.exec(
        "INSERT OR IGNORE INTO used_live_tickets (nonce, expires_at) VALUES (?, ?)",
        nonce,
        expiresAt,
      ).rowsWritten > 0
    );
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

  storedSegmentBytes(): number {
    return this.sql.exec<CountRow>("SELECT COALESCE(SUM(bytes), 0) AS count FROM segments").one()
      .count;
  }

  storedAcceptedBytes(): number {
    return this.sql
      .exec<CountRow>(
        `SELECT COALESCE(SUM(bytes + length(CAST(events AS BLOB))), 0) AS count
        FROM batches`,
      )
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
    const sql = this.sql;
    return {
      *[Symbol.iterator]() {
        let afterT0 = Number.MIN_SAFE_INTEGER;
        let afterTab = "";
        let afterSeq = -1;

        for (;;) {
          // Close each SQL cursor before the streamed R2 writer can pause on
          // backpressure. The small page is replayable and memory-bounded.
          const page = sql
            .exec<PagedStoredEventRow>(
              `SELECT t0, tab, seq, events
              FROM batches
              WHERE t0 > ?
                OR (t0 = ? AND tab > ?)
                OR (t0 = ? AND tab = ? AND seq > ?)
              ORDER BY t0, tab, seq
              LIMIT 50`,
              afterT0,
              afterT0,
              afterTab,
              afterT0,
              afterTab,
              afterSeq,
            )
            .toArray();
          if (page.length === 0) return;

          for (const row of page) yield row;
          const last = page.at(-1);
          if (last === undefined || page.length < 50) return;
          afterT0 = last.t0;
          afterTab = last.tab;
          afterSeq = last.seq;
        }
      },
    };
  }

  finalPageBatches(): Iterable<StoredPageBatch> {
    const sql = this.sql;
    return {
      *[Symbol.iterator]() {
        let afterTab = "";
        let afterSeq = -1;

        for (;;) {
          // Materialize the small page synchronously so no SQLite cursor can
          // remain open across later R2 or queue awaits.
          const page = sql
            .exec<StoredPageBatchRow>(
              `SELECT tab, seq, t0, t1, events
              FROM batches
              WHERE tab > ? OR (tab = ? AND seq > ?)
              ORDER BY tab, seq
              LIMIT ${FINALIZE_METADATA_PAGE_SIZE}`,
              afterTab,
              afterTab,
              afterSeq,
            )
            .toArray();
          if (page.length === 0) return;

          for (const row of page) {
            const metadata = parseStoredBatchMetadata(row.events);
            yield {
              tab: row.tab,
              seq: row.seq,
              t0: row.t0,
              t1: row.t1,
              events: metadata.events,
              pageAnalyticsVersion: metadata.pageAnalyticsVersion,
              ...(metadata.url === undefined ? {} : { url: metadata.url }),
            };
          }

          const last = page.at(-1);
          if (last === undefined || page.length < FINALIZE_METADATA_PAGE_SIZE) return;
          afterTab = last.tab;
          afterSeq = last.seq;
        }
      },
    };
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

  segmentRowsForManifest(): Iterable<SegmentForManifest> {
    const sql = this.sql;
    return {
      *[Symbol.iterator]() {
        const totalCheckpointSegments = sql
          .exec<CountRow>(`SELECT COUNT(*) AS count
            FROM segments
            WHERE json_type(events, '$.checkpoints') = 'array'
              AND json_array_length(json_extract(events, '$.checkpoints')) > 0`)
          .one().count;
        const selectedCheckpointSegmentIndexes =
          totalCheckpointSegments > MAX_MANIFEST_TOTAL_CHECKPOINTS
            ? evenlySpacedIndexes(totalCheckpointSegments, MAX_MANIFEST_TOTAL_CHECKPOINTS)
            : null;
        const checkpointColumn =
          selectedCheckpointSegmentIndexes === null
            ? `CASE
                WHEN json_type(events, '$.checkpoints') = 'array'
                  THEN json_extract(events, '$.checkpoints')
                ELSE '[]'
              END`
            : `CASE
                WHEN json_array_length(json_extract(events, '$.checkpoints')) > 0
                  THEN json_array(json_extract(events, '$.checkpoints[0]'))
                ELSE '[]'
              END`;
        let afterSegment = 0;
        let segmentCount = 0;
        let checkpointSegmentCount = 0;

        for (;;) {
          // Select only checkpoint metadata. Segment timeline events are not
          // needed because finalization streams the canonical batch sidecars.
          const page = sql
            .exec<SegmentManifestRow>(
              `SELECT n, key, bytes, t0, t1, batches,
                CASE
                  WHEN json_type(events, '$.checkpoints') = 'array'
                    AND json_array_length(json_extract(events, '$.checkpoints')) > 0
                    THEN 1
                  ELSE 0
                END AS has_checkpoint,
                ${checkpointColumn} AS checkpoints
              FROM segments
              WHERE n > ?
              ORDER BY n
              LIMIT ${FINALIZE_METADATA_PAGE_SIZE}`,
              afterSegment,
            )
            .toArray();
          if (page.length === 0) return;

          for (const row of page) {
            segmentCount += 1;
            if (segmentCount > MAX_MANIFEST_SEGMENTS) {
              throw new Error("Stored session has too many segments for its manifest.");
            }
            const checkpointLimit =
              row.has_checkpoint === 0
                ? 0
                : checkpointLimitForSegment(
                    checkpointSegmentCount++,
                    totalCheckpointSegments,
                    selectedCheckpointSegmentIndexes,
                  );
            const checkpoints =
              checkpointLimit === 0
                ? []
                : thinStoredCheckpoints(
                    parseStoredSegmentCheckpoints(row.checkpoints),
                    checkpointLimit,
                  );
            yield {
              key: row.key,
              bytes: row.bytes,
              t0: row.t0,
              t1: row.t1,
              batches: row.batches,
              ...(checkpoints.length > 0 ? { checkpoints } : {}),
              events: [],
            };
          }

          const last = page.at(-1);
          if (last === undefined || page.length < FINALIZE_METADATA_PAGE_SIZE) return;
          afterSegment = last.n;
        }
      },
    };
  }

  replaceStateWithTombstone(tombstone: FinalizedTombstone): void {
    // Cloudflare SQLite Durable Objects coalesce consecutive synchronous
    // sql.exec writes with no intervening await into one atomic implicit
    // transaction. Verified 2026-07-15 against:
    // https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#write-coalescing
    this.sql.exec("DELETE FROM batches");
    this.sql.exec("DELETE FROM segments");
    this.sql.exec("DELETE FROM segment_intents");
    this.sql.exec("DELETE FROM state");
    this.sql.exec("INSERT INTO state (id, v) VALUES (1, ?)", JSON.stringify(tombstone));
  }
}

function checkpointLimitForSegment(
  checkpointSegmentIndex: number,
  totalCheckpointSegments: number,
  selectedCheckpointSegmentIndexes: ReadonlySet<number> | null,
): number {
  if (totalCheckpointSegments <= 0) return 0;
  if (selectedCheckpointSegmentIndexes !== null) {
    return selectedCheckpointSegmentIndexes.has(checkpointSegmentIndex) ? 1 : 0;
  }

  const base = Math.floor(MAX_MANIFEST_TOTAL_CHECKPOINTS / totalCheckpointSegments);
  const remainder = MAX_MANIFEST_TOTAL_CHECKPOINTS % totalCheckpointSegments;
  return Math.min(128, base + (checkpointSegmentIndex < remainder ? 1 : 0));
}

function evenlySpacedIndexes(total: number, count: number): Set<number> {
  if (count <= 0 || total <= 0) return new Set();
  if (count === 1) return new Set([0]);

  const indexes = new Set<number>();
  for (let slot = 0; slot < count; slot += 1) {
    indexes.add(Math.round((slot * (total - 1)) / (count - 1)));
  }
  return indexes;
}

function thinStoredCheckpoints(
  checkpoints: readonly SegmentCheckpoint[],
  limit: number,
): SegmentCheckpoint[] {
  if (limit <= 0 || checkpoints.length === 0) return [];

  const ordered = checkpoints.toSorted(
    (left, right) =>
      left.timestamp - right.timestamp ||
      left.batch - right.batch ||
      left.tab.localeCompare(right.tab),
  );
  if (ordered.length <= limit) return ordered;
  if (limit === 1) return ordered.slice(0, 1);

  const selected = new Set<number>([0, ordered.length - 1]);
  const seenTabs = new Set<string>();
  for (const [index, checkpoint] of ordered.entries()) {
    if (selected.size >= limit) break;
    if (seenTabs.has(checkpoint.tab)) continue;
    seenTabs.add(checkpoint.tab);
    selected.add(index);
  }

  for (let slot = 0; slot < limit && selected.size < limit; slot += 1) {
    selected.add(Math.round((slot * (ordered.length - 1)) / (limit - 1)));
  }
  for (let index = 0; index < ordered.length && selected.size < limit; index += 1) {
    selected.add(index);
  }

  return [...selected]
    .toSorted((left, right) => left - right)
    .slice(0, limit)
    .map((index) => ordered[index])
    .filter((checkpoint) => checkpoint !== undefined);
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
