import type { AnalyticsRecordKind } from "./export-record.ts";

const DEFAULT_BATCH_SIZE = 90;
// D1 allows at most 100 bound values in one statement. Status updates also
// bind a timestamp or error before these ids, so keep a little headroom.
const MAX_BATCH_SIZE = 90;
const MAX_STORED_ERROR_CHARS = 500;
export const ANALYTICS_OUTBOX_SAFETY_MS = 24 * 60 * 60 * 1_000;

export interface AnalyticsOutboxRow {
  exportSequence: number;
  exportId: string;
  projectId: string;
  sessionId: string;
  recordKind: AnalyticsRecordKind;
  payloadJson: string;
  createdAt: number;
  sentAt: number | null;
  attemptCount: number;
  lastError: string | null;
  quarantinedAt: number | null;
  quarantineReason: string | null;
  sidecarEventOffset: number;
}

export interface AnalyticsWarehouseState {
  projectId: string;
  verifiedSequence: number;
  verifiedAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
}

export interface SaveWarehouseStateInput {
  projectId: string;
  verifiedSequence: number;
  verifiedAt: number | null;
  lastAttemptAt: number;
  lastError: string | null;
}

export interface AnalyticsOutboxCompactionResult {
  copiedToLedger: number;
  deletedPayloadRows: number;
  deletedDeniedLedgerRows: number;
}

export interface AnalyticsOutboxStore {
  listPending(limit: number): Promise<AnalyticsOutboxRow[]>;
  canSendRecord(
    projectId: string,
    sessionId: string,
    recordKind: AnalyticsRecordKind,
  ): Promise<boolean>;
  markSent(exportSequences: readonly number[], sentAt: number): Promise<void>;
  markFailed(exportSequences: readonly number[], error: string): Promise<void>;
  markQuarantined(
    exportSequences: readonly number[],
    reason: string,
    quarantinedAt: number,
  ): Promise<void>;
  saveSidecarProgress(exportSequence: number, nextEventIndex: number): Promise<void>;
  listProjectIds(limit: number): Promise<string[]>;
  readWarehouseState(projectId: string): Promise<AnalyticsWarehouseState>;
  listProjectRowsAfter(
    projectId: string,
    verifiedSequence: number,
    limit: number,
  ): Promise<AnalyticsOutboxRow[]>;
  resetForRetry(exportSequences: readonly number[], error: string): Promise<void>;
  saveWarehouseState(input: SaveWarehouseStateInput): Promise<void>;
}

interface D1OutboxRow {
  export_sequence: number;
  export_id: string;
  project_id: string;
  session_id: string;
  record_kind: string;
  payload_json: string;
  created_at: number;
  sent_at: number | null;
  attempt_count: number;
  last_error: string | null;
  quarantined_at: number | null;
  quarantine_reason: string | null;
  sidecar_event_offset: number;
}

interface D1WarehouseStateRow {
  project_id: string;
  verified_sequence: number;
  verified_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
}

export function createD1AnalyticsOutboxStore(db: D1Database): AnalyticsOutboxStore {
  return {
    async listPending(limit) {
      const result = await db
        .prepare(
          `SELECT o.export_sequence, o.export_id, o.project_id, o.session_id, o.record_kind,
            o.payload_json,
            created_at, sent_at, attempt_count, last_error, quarantined_at, quarantine_reason,
            sidecar_event_offset
          FROM analytics_export_outbox o
          WHERE o.sent_at IS NULL
            AND o.quarantined_at IS NULL
          ORDER BY o.export_sequence
          LIMIT ?`,
        )
        .bind(safeBatchSize(limit))
        .all<D1OutboxRow>();
      return result.results.map(toOutboxRow);
    },

    async canSendRecord(projectId, sessionId, recordKind) {
      const allowed = await db
        .prepare(
          `SELECT CASE
            WHEN ? = 'deletion' THEN EXISTS (
              SELECT 1
              FROM analytics_deletion_jobs j
              WHERE j.project_id = ?
                AND j.session_id = ?
                AND j.requires_warehouse_tombstone = 1
            )
            ELSE EXISTS (
              SELECT 1
              FROM projects p
              WHERE p.id = ?
                AND p.jurisdiction IS NULL
            )
          END AS allowed`,
        )
        .bind(recordKind, projectId, sessionId, projectId)
        .first<{ allowed: number }>();
      return allowed?.allowed === 1;
    },

    async markSent(exportSequences, sentAt) {
      if (exportSequences.length === 0) return;
      await db
        .prepare(
          `UPDATE analytics_export_outbox
          SET sent_at = ?, attempt_count = attempt_count + 1, last_error = NULL
          WHERE export_sequence IN (${placeholders(exportSequences.length)})`,
        )
        .bind(sentAt, ...exportSequences)
        .run();
    },

    async markFailed(exportSequences, error) {
      if (exportSequences.length === 0) return;
      await db
        .prepare(
          `UPDATE analytics_export_outbox
          SET attempt_count = attempt_count + 1, last_error = ?
          WHERE export_sequence IN (${placeholders(exportSequences.length)})`,
        )
        .bind(safeError(error), ...exportSequences)
        .run();
    },

    async markQuarantined(exportSequences, reason, quarantinedAt) {
      if (exportSequences.length === 0) return;
      await db
        .prepare(
          `UPDATE analytics_export_outbox
          SET attempt_count = attempt_count + 1,
            last_error = ?, quarantined_at = ?, quarantine_reason = ?
          WHERE export_sequence IN (${placeholders(exportSequences.length)})
            AND quarantined_at IS NULL`,
        )
        .bind(safeError(reason), safeNow(quarantinedAt), safeError(reason), ...exportSequences)
        .run();
    },

    async saveSidecarProgress(exportSequence, nextEventIndex) {
      if (!Number.isSafeInteger(exportSequence) || exportSequence <= 0) {
        throw new Error("Analytics sidecar progress has an invalid export sequence.");
      }
      if (!Number.isSafeInteger(nextEventIndex) || nextEventIndex < 0) {
        throw new Error("Analytics sidecar progress has an invalid event index.");
      }
      await db
        .prepare(
          `UPDATE analytics_export_outbox
          SET sidecar_event_offset = ?
          WHERE export_sequence = ?
            AND sidecar_event_offset < ?
            AND sent_at IS NULL
            AND quarantined_at IS NULL`,
        )
        .bind(nextEventIndex, exportSequence, nextEventIndex)
        .run();
    },

    async listProjectIds(limit) {
      const result = await db
        .prepare(
          `SELECT o.project_id
          FROM analytics_export_outbox o
          LEFT JOIN analytics_warehouse_state s ON s.project_id = o.project_id
          WHERE o.export_sequence > COALESCE(s.verified_sequence, 0)
          GROUP BY o.project_id, s.last_attempt_at
          ORDER BY COALESCE(s.last_attempt_at, 0), MIN(o.export_sequence), o.project_id
          LIMIT ?`,
        )
        .bind(safeBatchSize(limit))
        .all<{ project_id: string }>();
      return result.results.map((row) => row.project_id);
    },

    async readWarehouseState(projectId) {
      const row = await db
        .prepare(
          `SELECT project_id, verified_sequence, verified_at, last_attempt_at, last_error
          FROM analytics_warehouse_state
          WHERE project_id = ?`,
        )
        .bind(projectId)
        .first<D1WarehouseStateRow>();

      return row === null
        ? {
            projectId,
            verifiedSequence: 0,
            verifiedAt: null,
            lastAttemptAt: null,
            lastError: null,
          }
        : toWarehouseState(row);
    },

    async listProjectRowsAfter(projectId, verifiedSequence, limit) {
      const result = await db
        .prepare(
          `SELECT export_sequence, export_id, project_id, session_id, record_kind, payload_json,
            created_at, sent_at, attempt_count, last_error, quarantined_at, quarantine_reason,
            sidecar_event_offset
          FROM analytics_export_outbox
          WHERE project_id = ? AND export_sequence > ?
          ORDER BY export_sequence
          LIMIT ?`,
        )
        .bind(projectId, verifiedSequence, safeBatchSize(limit))
        .all<D1OutboxRow>();
      return result.results.map(toOutboxRow);
    },

    async resetForRetry(exportSequences, error) {
      if (exportSequences.length === 0) return;
      await db
        .prepare(
          `UPDATE analytics_export_outbox
          SET sent_at = NULL, last_error = ?
          WHERE export_sequence IN (${placeholders(exportSequences.length)})`,
        )
        .bind(safeError(error), ...exportSequences)
        .run();
    },

    async saveWarehouseState(input) {
      await db
        .prepare(
          `INSERT INTO analytics_warehouse_state (
            project_id, verified_sequence, verified_at, last_attempt_at, last_error
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET
            verified_sequence = CASE
              WHEN excluded.verified_sequence > analytics_warehouse_state.verified_sequence
                THEN excluded.verified_sequence
              ELSE analytics_warehouse_state.verified_sequence
            END,
            verified_at = CASE
              WHEN excluded.verified_sequence > analytics_warehouse_state.verified_sequence
                THEN excluded.verified_at
              ELSE analytics_warehouse_state.verified_at
            END,
            last_attempt_at = excluded.last_attempt_at,
            last_error = excluded.last_error`,
        )
        .bind(
          input.projectId,
          input.verifiedSequence,
          input.verifiedAt,
          input.lastAttemptAt,
          input.lastError === null ? null : safeError(input.lastError),
        )
        .run();
    },
  };
}

/**
 * Remembers verified export identities without keeping their full JSON payload.
 *
 * D1 batch statements are one transaction. A row is first copied to the small
 * ledger after its warehouse watermark is verified. Its payload stays in the
 * outbox for another 24 hours before deletion. This row-level timestamp avoids
 * using the project's moving verified_at value, which would starve busy
 * projects or shorten the safety window.
 */
export async function compactVerifiedAnalyticsOutbox(
  db: D1Database,
  options: { limit?: number; now?: number } = {},
): Promise<AnalyticsOutboxCompactionResult> {
  const limit = safeBatchSize(options.limit ?? DEFAULT_BATCH_SIZE);
  const now = safeNow(options.now);
  const deleteBefore = now - ANALYTICS_OUTBOX_SAFETY_MS;

  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM analytics_export_ledger
        WHERE export_id IN (
          SELECT l.export_id
          FROM analytics_export_ledger l
          INNER JOIN session_deletions d
            ON d.project_id = l.project_id AND d.session_id = l.session_id
          WHERE l.record_kind <> 'deletion'
            OR (
              l.first_seen_verified_at <= ?
              AND NOT EXISTS (
                SELECT 1 FROM analytics_export_outbox o
                WHERE o.export_id = l.export_id
              )
              AND EXISTS (
                SELECT 1 FROM analytics_deletion_jobs j
                WHERE j.project_id = l.project_id
                  AND j.session_id = l.session_id
                  AND j.completed_at IS NOT NULL
              )
            )
          ORDER BY l.export_sequence
          LIMIT ?
        )`,
      )
      .bind(deleteBefore, limit),
    db
      .prepare(
        `INSERT INTO analytics_export_ledger (
          export_id, export_sequence, project_id, session_id, record_kind,
          sent_at, first_seen_verified_at
        )
        SELECT
          o.export_id, o.export_sequence, o.project_id, o.session_id, o.record_kind,
          o.sent_at, ?
        FROM analytics_export_outbox o
        INNER JOIN analytics_warehouse_state s ON s.project_id = o.project_id
        WHERE o.sent_at IS NOT NULL
          AND o.export_sequence <= s.verified_sequence
          AND s.verified_at IS NOT NULL
          AND s.verified_at <= ?
          AND (
            o.record_kind = 'deletion'
            OR NOT EXISTS (
              SELECT 1
              FROM session_deletions d
              WHERE d.project_id = o.project_id AND d.session_id = o.session_id
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM analytics_export_ledger l
            WHERE l.export_id = o.export_id
              AND l.export_sequence = o.export_sequence
              AND l.project_id = o.project_id
              AND l.session_id = o.session_id
              AND l.record_kind = o.record_kind
              AND l.sent_at = o.sent_at
          )
        ORDER BY o.export_sequence
        LIMIT ?
        ON CONFLICT(export_id) DO UPDATE SET
          export_sequence = excluded.export_sequence,
          project_id = excluded.project_id,
          session_id = excluded.session_id,
          record_kind = excluded.record_kind,
          sent_at = excluded.sent_at,
          first_seen_verified_at = excluded.first_seen_verified_at`,
      )
      .bind(now, now, limit),
    db
      .prepare(
        `DELETE FROM analytics_export_outbox
        WHERE export_id IN (
          SELECT o.export_id
          FROM analytics_export_outbox o
          INNER JOIN analytics_export_ledger l
            ON l.export_id = o.export_id
            AND l.export_sequence = o.export_sequence
            AND l.project_id = o.project_id
            AND l.session_id = o.session_id
            AND l.record_kind = o.record_kind
            AND l.sent_at = o.sent_at
          INNER JOIN analytics_warehouse_state s ON s.project_id = o.project_id
          WHERE o.sent_at IS NOT NULL
            AND o.export_sequence <= s.verified_sequence
            AND l.first_seen_verified_at <= ?
          ORDER BY o.export_sequence
          LIMIT ?
        )`,
      )
      .bind(deleteBefore, limit),
  ]);

  return {
    deletedDeniedLedgerRows: changedRows(results[0]),
    copiedToLedger: changedRows(results[1]),
    deletedPayloadRows: changedRows(results[2]),
  };
}

export function safeOutboxBatchSize(value = DEFAULT_BATCH_SIZE): number {
  return safeBatchSize(value);
}

function safeBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(value, MAX_BATCH_SIZE);
}

function safeNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Analytics state write received an invalid time.");
  }
  return now;
}

function changedRows(result: D1Result | undefined): number {
  return result?.meta.changes ?? 0;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function safeError(error: string): string {
  return error.length <= MAX_STORED_ERROR_CHARS ? error : error.slice(0, MAX_STORED_ERROR_CHARS);
}

function toOutboxRow(row: D1OutboxRow): AnalyticsOutboxRow {
  if (!isRecordKind(row.record_kind)) {
    throw new Error(`analytics outbox has unknown record kind ${row.record_kind}`);
  }
  if (!Number.isSafeInteger(row.export_sequence) || row.export_sequence <= 0) {
    throw new Error("analytics outbox has an invalid export sequence");
  }

  return {
    exportSequence: row.export_sequence,
    exportId: row.export_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    recordKind: row.record_kind,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    quarantinedAt: row.quarantined_at,
    quarantineReason: row.quarantine_reason,
    sidecarEventOffset: row.sidecar_event_offset,
  };
}

function toWarehouseState(row: D1WarehouseStateRow): AnalyticsWarehouseState {
  return {
    projectId: row.project_id,
    verifiedSequence: row.verified_sequence,
    verifiedAt: row.verified_at,
    lastAttemptAt: row.last_attempt_at,
    lastError: row.last_error,
  };
}

function isRecordKind(value: string): value is AnalyticsRecordKind {
  return value === "session" || value === "event" || value === "deletion";
}
