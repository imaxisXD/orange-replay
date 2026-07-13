export const MAX_PURGE_CLAIM_JOBS = 500;
export const MAX_PURGE_REPORT_JOBS = 20;
export const ANALYTICS_PURGE_QUIET_MS = 10 * 60 * 1_000;
export const ANALYTICS_PURGE_LEASE_MS = 45 * 60 * 1_000;
export const ANALYTICS_PURGE_ALERT_MS = 23 * 60 * 60 * 1_000;

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

export async function claimAnalyticsPurgeJobs(
  db: D1Database,
  ownerId: string,
  now = Date.now(),
  limit = MAX_PURGE_CLAIM_JOBS,
): Promise<AnalyticsPurgeClaim> {
  checkOwner(ownerId);
  const safeNow = checkTime(now);
  const safeLimit = checkLimit(limit);
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
  const safeNow = checkTime(now);
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
    const error = safeError(result.error);
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
  const safeNow = checkTime(now);
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

function checkTime(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Analytics purge time is invalid.");
  }
  return value;
}

function checkLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PURGE_CLAIM_JOBS) {
    throw new Error(`Analytics purge limit must be from 1 to ${MAX_PURGE_CLAIM_JOBS}.`);
  }
  return value;
}

function safeError(value: string | undefined): string | null {
  if (value === undefined) return null;
  const clean = value.trim();
  if (clean.length === 0) return "Unknown analytics purge error.";
  return clean.slice(0, 500);
}
