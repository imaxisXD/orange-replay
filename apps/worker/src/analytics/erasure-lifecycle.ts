import { buildDeletionRecord, serializeAnalyticsPayload } from "./export-record.ts";

export const ANALYTICS_ERASURE_BATCH_SIZE = 15;
export const MAX_PURGE_CLAIM_JOBS = 500;
export const MAX_PURGE_REPORT_JOBS = 20;
export const ANALYTICS_PURGE_QUIET_MS = 10 * 60 * 1_000;
export const ANALYTICS_PURGE_LEASE_MS = 45 * 60 * 1_000;
export const ANALYTICS_PURGE_ALERT_MS = 23 * 60 * 60 * 1_000;

const JOURNAL_BATCH_SIZE = 200;
const MAX_JOURNAL_PASSES = 10;

export interface AnalyticsErasureRequest {
  sessionId: string;
  projectId: string;
  startedAt: number;
  deleteReason: "retention_expired" | "delete_requested";
  requiresWarehouseTombstone: number;
}

interface DeletionJournalJob {
  projectId: string;
  sessionId: string;
  requestedAt: number;
  deleteReason: string;
}

export interface AnalyticsDeletionV2Job {
  projectId: string;
  sessionId: string;
  requestedAt: number;
  deleteReason: string;
  sessionStartedAt: number | null;
  exportSequence: number;
}

export interface AnalyticsDeletionV2Counts {
  requiredJobs: number;
  visibleJobs: number;
}

interface D1PurgeJobRow {
  project_id: string;
  session_id: string;
  requested_at: number;
  delete_reason: string;
  first_zero_at: number | null;
  requires_warehouse_tombstone: number;
}

export interface AnalyticsPurgeJob {
  projectId: string;
  sessionId: string;
  requestedAt: number;
  deleteReason: string;
  requiresWarehouseTombstone: boolean;
  needsPhysicalMaintenance: boolean;
}

export interface AnalyticsPurgeClaim {
  jobs: AnalyticsPurgeJob[];
  deadlineRisk: boolean;
  oldestPendingAt: number | null;
}

export interface AnalyticsPurgeResult {
  projectId: string;
  sessionId: string;
  rowsRemaining: number;
  rowsFoundBefore: number;
  error?: string;
}

/** Saves the durable erasure request before replay rows and objects are removed. */
export async function recordAnalyticsErasureRequests(
  db: D1Database,
  rows: readonly AnalyticsErasureRequest[],
  now: number,
): Promise<void> {
  for (const chunk of chunkList(rows, ANALYTICS_ERASURE_BATCH_SIZE)) {
    const placeholders = chunk.map(() => "(?, ?, ?, 1)").join(", ");
    const values = chunk.flatMap((row) => [row.projectId, row.sessionId, now]);
    const statements = [
      db
        .prepare(
          `INSERT INTO session_deletions (project_id, session_id, requested_at, attempts)
        VALUES ${placeholders}
        ON CONFLICT(project_id, session_id) DO UPDATE SET
          attempts = attempts + 1,
          last_error = NULL`,
        )
        .bind(...values),
      db
        .prepare(
          `INSERT INTO analytics_deletion_jobs (
            project_id, session_id, requested_at, delete_reason,
            requires_warehouse_tombstone, session_started_at
          ) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
          ON CONFLICT(project_id, session_id) DO UPDATE SET
            requested_at = MIN(analytics_deletion_jobs.requested_at, excluded.requested_at),
            delete_reason = excluded.delete_reason,
            session_started_at = COALESCE(
              analytics_deletion_jobs.session_started_at,
              excluded.session_started_at
            ),
            requires_warehouse_tombstone = CASE
              WHEN analytics_deletion_jobs.requires_warehouse_tombstone = 1
                OR excluded.requires_warehouse_tombstone = 1
              THEN 1
              ELSE 0
            END,
            completed_at = NULL`,
        )
        .bind(
          ...chunk.flatMap((row) => [
            row.projectId,
            row.sessionId,
            now,
            row.deleteReason,
            row.requiresWarehouseTombstone,
            row.startedAt,
          ]),
        ),
      db
        .prepare(
          `DELETE FROM analytics_export_outbox
          WHERE record_kind IN ('session', 'event')
            AND (project_id, session_id) IN (${chunk.map(() => "(?, ?)").join(", ")})`,
        )
        .bind(...chunk.flatMap((row) => [row.projectId, row.sessionId])),
    ];
    await db.batch(statements);
  }
}

/** Queues durable warehouse tombstones that survived an earlier export outage. */
export async function queueDeletionExportsFromJournal(
  db: D1Database,
  now = Date.now(),
): Promise<number> {
  const safeNow = checkedJournalTime(now);
  let queued = 0;
  for (let pass = 0; pass < MAX_JOURNAL_PASSES; pass += 1) {
    const result = await db
      .prepare(
        `SELECT
          j.project_id AS projectId,
          j.session_id AS sessionId,
          j.requested_at AS requestedAt,
          j.delete_reason AS deleteReason
        FROM analytics_deletion_jobs j
        WHERE j.deletion_export_sequence IS NULL
          AND j.completed_at IS NULL
          AND j.requires_warehouse_tombstone = 1
        ORDER BY j.requested_at, j.project_id, j.session_id
        LIMIT ?`,
      )
      .bind(JOURNAL_BATCH_SIZE)
      .all<DeletionJournalJob>();
    const jobs = result.results;
    if (jobs.length === 0) break;

    const deletionExports = jobs.map((job) => {
      const record = serializeAnalyticsPayload(
        buildDeletionRecord({
          projectId: job.projectId,
          sessionId: job.sessionId,
          deletedAt: job.requestedAt,
          reason: job.deleteReason,
        }),
      );
      return {
        export_id: record.exportId,
        project_id: record.projectId,
        session_id: record.sessionId,
        record_kind: record.recordKind,
        payload_json: record.payloadJson,
      };
    });

    const batchResults = await db.batch([
      db
        .prepare(
          `WITH incoming AS (
            SELECT
              json_extract(value, '$.export_id') AS export_id,
              json_extract(value, '$.project_id') AS project_id,
              json_extract(value, '$.session_id') AS session_id,
              json_extract(value, '$.record_kind') AS record_kind,
              json_extract(value, '$.payload_json') AS payload_json
            FROM json_each(?)
          )
          INSERT OR IGNORE INTO analytics_export_outbox (
            export_id, project_id, session_id, record_kind, payload_json, created_at
          )
          SELECT export_id, project_id, session_id, record_kind, payload_json, ?
          FROM incoming
          WHERE NOT EXISTS (
            SELECT 1 FROM analytics_export_ledger l
            WHERE l.export_id = incoming.export_id
            )
            AND EXISTS (
              SELECT 1 FROM analytics_deletion_jobs j
              WHERE j.project_id = incoming.project_id
                AND j.session_id = incoming.session_id
                AND j.completed_at IS NULL
                AND j.requires_warehouse_tombstone = 1
            )`,
        )
        .bind(JSON.stringify(deletionExports), safeNow),
      db.prepare(
        `UPDATE analytics_deletion_jobs
        SET deletion_export_sequence = COALESCE(
          (
            SELECT o.export_sequence
            FROM analytics_export_outbox o
            WHERE o.export_id = 'deletion:' || analytics_deletion_jobs.project_id || ':' || analytics_deletion_jobs.session_id
          ),
          (
            SELECT l.export_sequence
            FROM analytics_export_ledger l
            WHERE l.export_id = 'deletion:' || analytics_deletion_jobs.project_id || ':' || analytics_deletion_jobs.session_id
          )
        )
        WHERE deletion_export_sequence IS NULL
          AND completed_at IS NULL
          AND requires_warehouse_tombstone = 1`,
      ),
    ]);
    queued += batchResults[0]?.meta.changes ?? 0;
    if (jobs.length < JOURNAL_BATCH_SIZE) break;
  }
  return queued;
}

export async function listUnsentAnalyticsDeletionV2Jobs(
  db: D1Database,
  limit: number,
): Promise<AnalyticsDeletionV2Job[]> {
  return listAnalyticsDeletionV2Jobs(db, "j.deletion_v2_sent_at IS NULL", [], limit);
}

export async function listAnalyticsDeletionV2JobsAwaitingVisibility(
  db: D1Database,
  visibleBefore: number,
  limit: number,
): Promise<AnalyticsDeletionV2Job[]> {
  return listAnalyticsDeletionV2Jobs(
    db,
    "j.deletion_v2_sent_at IS NOT NULL AND j.deletion_v2_sent_at <= ?",
    [visibleBefore],
    limit,
  );
}

export async function markAnalyticsDeletionV2Sent(
  db: D1Database,
  jobs: readonly AnalyticsDeletionV2Job[],
  now: number,
): Promise<void> {
  if (jobs.length === 0) return;
  await db.batch(
    jobs.map((job) =>
      db
        .prepare(
          `UPDATE analytics_deletion_jobs
          SET deletion_v2_sent_at = ?,
            deletion_v2_attempt_count = deletion_v2_attempt_count + 1,
            deletion_v2_last_error = NULL
          WHERE project_id = ? AND session_id = ?
            AND requires_warehouse_tombstone = 1
            AND requested_at = ?
            AND delete_reason = ?
            AND deletion_export_sequence = ?
            AND session_started_at IS ?
            AND deletion_v2_visible_at IS NULL`,
        )
        .bind(
          now,
          job.projectId,
          job.sessionId,
          job.requestedAt,
          job.deleteReason,
          job.exportSequence,
          job.sessionStartedAt,
        ),
    ),
  );
}

export async function markAnalyticsDeletionV2Failed(
  db: D1Database,
  jobs: readonly AnalyticsDeletionV2Job[],
  error: string,
): Promise<void> {
  if (jobs.length === 0) return;
  await db.batch(
    jobs.map((job) =>
      db
        .prepare(
          `UPDATE analytics_deletion_jobs
          SET deletion_v2_attempt_count = deletion_v2_attempt_count + 1,
            deletion_v2_last_error = ?
          WHERE project_id = ? AND session_id = ?
            AND requires_warehouse_tombstone = 1
            AND deletion_v2_visible_at IS NULL`,
        )
        .bind(error, job.projectId, job.sessionId),
    ),
  );
}

export async function markAnalyticsDeletionV2Visible(
  db: D1Database,
  jobs: readonly AnalyticsDeletionV2Job[],
  now: number,
): Promise<void> {
  if (jobs.length === 0) return;
  await db.batch(
    jobs.map((job) =>
      db
        .prepare(
          `UPDATE analytics_deletion_jobs
          SET deletion_v2_visible_at = ?, deletion_v2_last_error = NULL
          WHERE project_id = ? AND session_id = ?
            AND deletion_v2_sent_at IS NOT NULL
            AND requested_at = ?
            AND delete_reason = ?
            AND deletion_export_sequence = ?
            AND session_started_at IS ?
            AND deletion_v2_visible_at IS NULL`,
        )
        .bind(
          now,
          job.projectId,
          job.sessionId,
          job.requestedAt,
          job.deleteReason,
          job.exportSequence,
          job.sessionStartedAt,
        ),
    ),
  );
}

export async function resetAnalyticsDeletionV2ForRetry(
  db: D1Database,
  jobs: readonly AnalyticsDeletionV2Job[],
): Promise<void> {
  if (jobs.length === 0) return;
  const error = "Analytics deletion v2 record is not visible yet.";
  await db.batch(
    jobs.map((job) =>
      db
        .prepare(
          `UPDATE analytics_deletion_jobs
          SET deletion_v2_sent_at = NULL, deletion_v2_last_error = ?
          WHERE project_id = ? AND session_id = ?
            AND requested_at = ?
            AND delete_reason = ?
            AND deletion_export_sequence = ?
            AND session_started_at IS ?
            AND deletion_v2_visible_at IS NULL`,
        )
        .bind(
          error,
          job.projectId,
          job.sessionId,
          job.requestedAt,
          job.deleteReason,
          job.exportSequence,
          job.sessionStartedAt,
        ),
    ),
  );
}

export async function readAnalyticsDeletionV2Counts(
  db: D1Database,
): Promise<AnalyticsDeletionV2Counts> {
  const row = await db
    .prepare(
      `SELECT
        COUNT(*) AS requiredJobs,
        COALESCE(SUM(CASE WHEN deletion_v2_visible_at IS NOT NULL THEN 1 ELSE 0 END), 0)
          AS visibleJobs
      FROM analytics_deletion_jobs
      WHERE requires_warehouse_tombstone = 1`,
    )
    .first<AnalyticsDeletionV2Counts>();
  if (
    row === null ||
    !Number.isSafeInteger(row.requiredJobs) ||
    row.requiredJobs < 0 ||
    !Number.isSafeInteger(row.visibleJobs) ||
    row.visibleJobs < 0 ||
    row.visibleJobs > row.requiredJobs
  ) {
    throw new Error("Analytics deletion v2 state returned invalid counts.");
  }
  return row;
}

export async function saveAnalyticsDeletionV2State(
  db: D1Database,
  counts: AnalyticsDeletionV2Counts,
  now: number,
  error: string | null,
  ready: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO analytics_deletion_v2_state (
        shard, required_job_count, visible_job_count, last_attempt_at,
        last_error, backfill_completed_at
      ) VALUES (0, ?, ?, ?, ?, ?)
      ON CONFLICT(shard) DO UPDATE SET
        required_job_count = excluded.required_job_count,
        visible_job_count = excluded.visible_job_count,
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        backfill_completed_at = excluded.backfill_completed_at`,
    )
    .bind(counts.requiredJobs, counts.visibleJobs, now, error, ready && error === null ? now : null)
    .run();
}

export async function claimAnalyticsPurgeJobs(
  db: D1Database,
  ownerId: string,
  now = Date.now(),
  limit = MAX_PURGE_CLAIM_JOBS,
): Promise<AnalyticsPurgeClaim> {
  checkOwner(ownerId);
  const safeNow = checkPurgeTime(now);
  const safeLimit = checkPurgeLimit(limit);
  const leaseExpiresAt = safeNow + ANALYTICS_PURGE_LEASE_MS;
  const eligibleBefore = safeNow - ANALYTICS_PURGE_QUIET_MS;

  const result = await db
    .prepare(
      `UPDATE analytics_deletion_jobs
      SET lease_owner = ?,
        lease_expires_at = ?,
        purge_attempts = purge_attempts + 1,
        purge_last_attempt_at = ?,
        purge_last_error = NULL
      WHERE (project_id, session_id) IN (
        SELECT j.project_id, j.session_id
        FROM analytics_deletion_jobs j
        LEFT JOIN analytics_warehouse_state s ON s.project_id = j.project_id
        WHERE j.completed_at IS NULL
          AND j.requested_at <= ?
          AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= ?)
          AND (j.first_zero_at IS NULL OR j.first_zero_at <= ?)
          AND (
            j.requires_warehouse_tombstone = 0
            OR (
              j.deletion_export_sequence IS NOT NULL
              AND j.deletion_export_sequence <= COALESCE(s.verified_sequence, 0)
            )
          )
        ORDER BY j.requested_at, j.project_id, j.session_id
        LIMIT ?
      )
      RETURNING project_id, session_id, requested_at, delete_reason, first_zero_at,
        requires_warehouse_tombstone`,
    )
    .bind(ownerId, leaseExpiresAt, safeNow, eligibleBefore, safeNow, eligibleBefore, safeLimit)
    .all<D1PurgeJobRow>();

  const oldest = await db
    .prepare(
      `SELECT MIN(requested_at) AS oldest
      FROM analytics_deletion_jobs
      WHERE completed_at IS NULL`,
    )
    .first<{ oldest: number | null }>();
  const oldestPendingAt = oldest?.oldest ?? null;

  return {
    jobs: result.results.map((row) => ({
      projectId: row.project_id,
      sessionId: row.session_id,
      requestedAt: row.requested_at,
      deleteReason: row.delete_reason,
      requiresWarehouseTombstone: row.requires_warehouse_tombstone === 1,
      needsPhysicalMaintenance: row.first_zero_at === null,
    })),
    deadlineRisk: oldestPendingAt !== null && oldestPendingAt <= safeNow - ANALYTICS_PURGE_ALERT_MS,
    oldestPendingAt,
  };
}

export async function reportAnalyticsPurgeResults(
  db: D1Database,
  ownerId: string,
  results: readonly AnalyticsPurgeResult[],
  now = Date.now(),
): Promise<{ completed: number; waitingForSecondCheck: number; failed: number }> {
  checkOwner(ownerId);
  if (results.length === 0 || results.length > MAX_PURGE_REPORT_JOBS) {
    throw new Error("Analytics purge report must contain 1 to 20 jobs.");
  }
  const safeNow = checkPurgeTime(now);
  const completeBefore = safeNow - ANALYTICS_PURGE_QUIET_MS;
  const statements: D1PreparedStatement[] = [];
  let failed = 0;
  let zeroRows = 0;
  const seenJobs = new Set<string>();

  for (const result of results) {
    checkPathId(result.projectId, "project id");
    checkPathId(result.sessionId, "session id");
    const jobKey = `${result.projectId}\u0000${result.sessionId}`;
    if (seenJobs.has(jobKey)) {
      throw new Error("Analytics purge report contains the same job more than once.");
    }
    seenJobs.add(jobKey);
    if (!Number.isSafeInteger(result.rowsRemaining) || result.rowsRemaining < 0) {
      throw new Error("Analytics purge report has an invalid remaining row count.");
    }
    const rowsFoundBefore = result.rowsFoundBefore;
    if (!Number.isSafeInteger(rowsFoundBefore) || rowsFoundBefore < 0) {
      throw new Error("Analytics purge report has an invalid earlier row count.");
    }
    const error = safePurgeError(result.error);
    if (error !== null) failed += 1;
    else if (result.rowsRemaining === 0) zeroRows += 1;

    statements.push(
      db
        .prepare(
          `UPDATE analytics_deletion_jobs
          SET purge_last_error = ?,
            first_zero_at = CASE
              WHEN ? IS NOT NULL OR ? > 0 THEN NULL
              WHEN ? > 0 THEN ?
              ELSE COALESCE(first_zero_at, ?)
            END,
            completed_at = CASE
              WHEN ? IS NULL AND ? = 0 AND ? = 0
                AND first_zero_at IS NOT NULL AND first_zero_at <= ?
                THEN ?
              ELSE completed_at
            END,
            lease_owner = NULL,
            lease_expires_at = NULL
          WHERE project_id = ? AND session_id = ? AND lease_owner = ?`,
        )
        .bind(
          error,
          error,
          result.rowsRemaining,
          rowsFoundBefore,
          safeNow,
          safeNow,
          error,
          result.rowsRemaining,
          rowsFoundBefore,
          completeBefore,
          safeNow,
          result.projectId,
          result.sessionId,
          ownerId,
        ),
    );
  }

  const updateResults = await db.batch(statements);
  const updated = updateResults.reduce((total, item) => total + (item.meta.changes ?? 0), 0);
  if (updated !== results.length) {
    throw new Error("Analytics purge report did not own every claimed job.");
  }
  const completedRow = await db
    .prepare(
      `SELECT COUNT(*) AS count
      FROM analytics_deletion_jobs
      WHERE completed_at = ?
        AND (project_id, session_id) IN (${results.map(() => "(?, ?)").join(", ")})`,
    )
    .bind(safeNow, ...results.flatMap((result) => [result.projectId, result.sessionId]))
    .first<{ count: number }>();
  const completed = completedRow?.count ?? 0;

  return {
    completed,
    waitingForSecondCheck: Math.max(0, zeroRows - completed),
    failed,
  };
}

export async function markPurgeDeadlineAlerted(db: D1Database, now = Date.now()): Promise<number> {
  const safeNow = checkPurgeTime(now);
  const result = await db
    .prepare(
      `UPDATE analytics_deletion_jobs
      SET alerted_at = ?
      WHERE completed_at IS NULL
        AND requested_at <= ?
        AND (alerted_at IS NULL OR alerted_at < ?)`,
    )
    .bind(safeNow, safeNow - ANALYTICS_PURGE_ALERT_MS, safeNow - 60 * 60 * 1_000)
    .run();
  return result.meta.changes ?? 0;
}

async function listAnalyticsDeletionV2Jobs(
  db: D1Database,
  extraWhere: string,
  bindings: readonly number[],
  limit: number,
): Promise<AnalyticsDeletionV2Job[]> {
  const result = await db
    .prepare(
      `SELECT
        j.project_id AS projectId,
        j.session_id AS sessionId,
        j.requested_at AS requestedAt,
        j.delete_reason AS deleteReason,
        j.session_started_at AS sessionStartedAt,
        j.deletion_export_sequence AS exportSequence
      FROM analytics_deletion_jobs j
      WHERE j.requires_warehouse_tombstone = 1
        AND j.deletion_v2_visible_at IS NULL
        AND ${extraWhere}
      ORDER BY j.deletion_v2_attempt_count, j.requested_at, j.project_id, j.session_id
      LIMIT ?`,
    )
    .bind(...bindings, limit)
    .all<AnalyticsDeletionV2Job>();
  return result.results;
}

function checkedJournalTime(now: number): number {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("Analytics deletion repair has an invalid time.");
  }
  return now;
}

function checkOwner(ownerId: string): void {
  if (ownerId.length === 0 || ownerId.length > 200) {
    throw new Error("Analytics purge owner id is invalid.");
  }
}

function checkPathId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(`Analytics purge ${label} is invalid.`);
  }
}

function checkPurgeTime(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Analytics purge time is invalid.");
  }
  return value;
}

function checkPurgeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PURGE_CLAIM_JOBS) {
    throw new Error(`Analytics purge limit must be from 1 to ${MAX_PURGE_CLAIM_JOBS}.`);
  }
  return value;
}

function safePurgeError(value: string | undefined): string | null {
  if (value === undefined) return null;
  const clean = value.trim();
  if (clean.length === 0) return "Unknown analytics purge error.";
  return clean.slice(0, 500);
}

function chunkList<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
