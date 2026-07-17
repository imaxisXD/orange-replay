interface AcceptedUsageRow {
  [key: string]: string | number | null;
  bytes: number | null;
  org_id: string | null;
  month: string | null;
  finalized: number;
  deleted: number;
  monthly_exists: number;
}

export interface AcceptedUsageReservation {
  projectId: string;
  sessionId: string;
  orgId: string;
  month: string;
  bytes: number;
  updatedAt: number;
  source: "append" | "finalize";
}

/**
 * Monotonically reserves accepted storage for one session. The ledger update
 * and monthly delta are one D1 batch, so retries can never charge the same
 * bytes twice.
 */
export async function reserveAcceptedUsage(
  db: D1Database,
  reservation: AcceptedUsageReservation,
): Promise<void> {
  const bytes = normalizedBytes(reservation.bytes);
  const results = await db.batch<AcceptedUsageRow>([
    db
      .prepare(
        `INSERT INTO accepted_usage_sessions (
          project_id, session_id, org_id, month, bytes, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM sessions WHERE project_id = ? AND session_id = ?
        )
          AND NOT EXISTS (
            SELECT 1 FROM session_deletions WHERE project_id = ? AND session_id = ?
          )
        ON CONFLICT(project_id, session_id) DO NOTHING`,
      )
      .bind(
        reservation.projectId,
        reservation.sessionId,
        reservation.orgId,
        reservation.month,
        bytes,
        reservation.updatedAt,
        reservation.projectId,
        reservation.sessionId,
        reservation.projectId,
        reservation.sessionId,
      ),
    db
      .prepare(
        `INSERT INTO usage_monthly (org_id, month, sessions, bytes)
        SELECT ?, ?, 0, ?
        WHERE (SELECT changes()) > 0
        ON CONFLICT(org_id, month) DO UPDATE SET
          bytes = bytes + excluded.bytes`,
      )
      .bind(reservation.orgId, reservation.month, bytes),
    db
      .prepare(
        `WITH pending(delta) AS (
          SELECT ? - ledger.bytes
          FROM accepted_usage_sessions AS ledger
          WHERE ledger.project_id = ?
            AND ledger.session_id = ?
            AND ledger.org_id = ?
            AND ledger.month = ?
            AND ledger.bytes < ?
            AND NOT EXISTS (
              SELECT 1 FROM sessions WHERE project_id = ? AND session_id = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM session_deletions WHERE project_id = ? AND session_id = ?
            )
        )
        UPDATE usage_monthly
        SET bytes = bytes + (SELECT delta FROM pending)
        WHERE org_id = ? AND month = ? AND EXISTS (SELECT 1 FROM pending)`,
      )
      .bind(
        bytes,
        reservation.projectId,
        reservation.sessionId,
        reservation.orgId,
        reservation.month,
        bytes,
        reservation.projectId,
        reservation.sessionId,
        reservation.projectId,
        reservation.sessionId,
        reservation.orgId,
        reservation.month,
      ),
    db
      .prepare(
        `UPDATE accepted_usage_sessions
        SET bytes = CASE WHEN bytes < ? THEN ? ELSE bytes END,
            updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
        WHERE project_id = ?
          AND session_id = ?
          AND org_id = ?
          AND month = ?
          AND NOT EXISTS (
            SELECT 1 FROM sessions WHERE project_id = ? AND session_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM session_deletions WHERE project_id = ? AND session_id = ?
          )
          AND bytes < ?`,
      )
      .bind(
        bytes,
        bytes,
        reservation.updatedAt,
        reservation.updatedAt,
        reservation.projectId,
        reservation.sessionId,
        reservation.orgId,
        reservation.month,
        reservation.projectId,
        reservation.sessionId,
        reservation.projectId,
        reservation.sessionId,
        bytes,
      ),
    db
      .prepare(
        `SELECT
        (SELECT bytes FROM accepted_usage_sessions
          WHERE project_id = ? AND session_id = ?) AS bytes,
        (SELECT org_id FROM accepted_usage_sessions
          WHERE project_id = ? AND session_id = ?) AS org_id,
        (SELECT month FROM accepted_usage_sessions
          WHERE project_id = ? AND session_id = ?) AS month,
        EXISTS(SELECT 1 FROM sessions
          WHERE project_id = ? AND session_id = ?) AS finalized,
        EXISTS(SELECT 1 FROM session_deletions
          WHERE project_id = ? AND session_id = ?) AS deleted,
        EXISTS(SELECT 1 FROM usage_monthly
          WHERE org_id = ? AND month = ?) AS monthly_exists`,
      )
      .bind(
        reservation.projectId,
        reservation.sessionId,
        reservation.projectId,
        reservation.sessionId,
        reservation.projectId,
        reservation.sessionId,
        reservation.projectId,
        reservation.sessionId,
        reservation.projectId,
        reservation.sessionId,
        reservation.orgId,
        reservation.month,
      ),
  ]);

  const result = results[4]?.results[0];
  const reservedBytes = result?.bytes;
  const reservationMatches =
    typeof reservedBytes === "number" &&
    reservedBytes >= bytes &&
    result?.org_id === reservation.orgId &&
    result.month === reservation.month &&
    result.monthly_exists === 1;
  if (reservationMatches) {
    if (reservation.source === "append" && (result.finalized === 1 || result.deleted === 1)) {
      throw new Error("Accepted usage cannot change after the session is closed.");
    }
    return;
  }

  // A finalize message from before the ledger deployment may be redelivered
  // after its session was already indexed. Its old consumer already charged it.
  if (reservation.source === "finalize" && result?.finalized === 1 && reservedBytes === null) {
    return;
  }
  // A deletion marker deliberately blocks indexing and its usage row. This
  // keeps a delayed finalize job from recreating billing after deletion.
  if (reservation.source === "finalize" && result?.deleted === 1 && reservedBytes === null) {
    return;
  }

  throw new Error("Accepted usage could not be reserved before session finalization.");
}

function normalizedBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Accepted usage bytes must be a non-negative whole number.");
  }
  return value;
}
