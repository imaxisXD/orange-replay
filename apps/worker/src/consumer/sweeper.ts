import {
  sessionPrefix,
  startWideEvent,
  uuidv7,
  type WideEventOutcome,
} from "@orange-replay/shared";
import { isValidPathId } from "../api/helpers.ts";
import {
  ANALYTICS_ERASURE_BATCH_SIZE,
  queueDeletionExportsFromJournal,
  recordAnalyticsErasureRequests,
} from "../analytics/erasure-lifecycle.ts";
import { analyticsExportEnabled, setWorkerLoggerVersion, shardDb, type Env } from "../env.ts";
import { chunkList } from "./helpers.ts";

const SESSION_SELECT_LIMIT = 200;
const R2_DELETE_LIMIT = 1_000;

export interface ExpiredSessionRow {
  sessionId: string;
  projectId: string;
  startedAt: number;
  deleteReason: "retention_expired" | "delete_requested";
  requiresWarehouseTombstone: number;
}

interface SweepTotals {
  sessionsDeleted: number;
  sessionsFailed: number;
  objectsDeleted: number;
}

export async function sweepExpiredSessions(env: Env): Promise<void> {
  setWorkerLoggerVersion(env);
  const requestId = uuidv7();
  const wideEvent = startWideEvent("worker", "consumer.sweep", requestId);
  const totals: SweepTotals = { sessionsDeleted: 0, sessionsFailed: 0, objectsDeleted: 0 };
  let outcome: WideEventOutcome = "success";

  try {
    const db = shardDb(env, 0);
    const now = Date.now();
    const exportEnabled = analyticsExportEnabled(env);
    if (exportEnabled && env.ANALYTICS_STREAM === undefined) {
      throw new Error("Analytics export is enabled, but its stream is not configured.");
    }
    if (exportEnabled) await queueDeletionExportsFromJournal(db, now);
    let firstDeleteError: unknown;

    for (;;) {
      const rows = await selectExpiredSessions(db, now);
      if (rows.length === 0) break;

      await markRowsForDeletion(db, rows, now);
      if (exportEnabled) await queueDeletionExportsFromJournal(db, now);

      const safelyDeleted: ExpiredSessionRow[] = [];
      for (const row of rows) {
        try {
          totals.objectsDeleted += await deleteSessionObjects(env.RECORDINGS, row);
          safelyDeleted.push(row);
        } catch (error) {
          totals.sessionsFailed += 1;
          firstDeleteError ??= error;
          await recordDeletionFailure(db, row, error);
        }
      }

      totals.sessionsDeleted += await deleteRowsForSessions(db, safelyDeleted);

      if (rows.length < SESSION_SELECT_LIMIT || safelyDeleted.length === 0) break;
    }

    if (firstDeleteError !== undefined) {
      throw firstDeleteError instanceof Error
        ? firstDeleteError
        : new Error("A session could not be deleted.");
    }
  } catch (err) {
    outcome = "server_error";
    wideEvent.fail(err);
    throw err;
  } finally {
    wideEvent.set({
      sessions_deleted: totals.sessionsDeleted,
      sessions_failed: totals.sessionsFailed,
      objects_deleted: totals.objectsDeleted,
    });
    wideEvent.emit(outcome);
  }
}

export async function selectExpiredSessions(
  db: D1Database,
  now: number,
): Promise<ExpiredSessionRow[]> {
  const result = await db
    .prepare(
      `SELECT sessions.session_id AS sessionId, sessions.project_id AS projectId,
        sessions.started_at AS startedAt,
        CASE WHEN sessions.expires_at < ? THEN 'retention_expired' ELSE 'delete_requested' END AS deleteReason,
        CASE
          WHEN p.id IS NULL OR p.jurisdiction IS NULL THEN 1
          WHEN EXISTS (
            SELECT 1
            FROM analytics_export_outbox o
            WHERE o.project_id = sessions.project_id
              AND o.session_id = sessions.session_id
          ) THEN 1
          WHEN EXISTS (
            SELECT 1
            FROM analytics_export_ledger l
            WHERE l.project_id = sessions.project_id
              AND l.session_id = sessions.session_id
          ) THEN 1
          ELSE 0
        END AS requiresWarehouseTombstone
      FROM sessions
      LEFT JOIN projects p ON p.id = sessions.project_id
      LEFT JOIN session_deletions d
        ON d.project_id = sessions.project_id AND d.session_id = sessions.session_id
      WHERE sessions.expires_at < ?
        OR EXISTS (
          SELECT 1 FROM session_deletions requested
          WHERE requested.project_id = sessions.project_id
            AND requested.session_id = sessions.session_id
        )
      ORDER BY COALESCE(d.attempts, 0), sessions.expires_at, sessions.project_id, sessions.session_id
      LIMIT 200`,
    )
    .bind(now, now)
    .all<ExpiredSessionRow>();
  return result.results;
}

async function deleteSessionObjects(bucket: R2Bucket, row: ExpiredSessionRow): Promise<number> {
  if (!isValidPathId(row.projectId) || !isValidPathId(row.sessionId)) {
    throw new Error("The session has an invalid storage id, so its data was not deleted.");
  }

  const prefix = `${sessionPrefix(row.projectId, row.sessionId)}/`;
  let cursor: string | undefined;
  let objectsDeleted = 0;

  for (;;) {
    const listed = await bucket.list({ prefix, cursor, limit: R2_DELETE_LIMIT });
    const keys = listed.objects.map((object) => object.key);

    for (const keyChunk of chunkList(keys, R2_DELETE_LIMIT)) {
      if (keyChunk.length > 0) {
        await bucket.delete(keyChunk);
        objectsDeleted += keyChunk.length;
      }
    }

    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  return objectsDeleted;
}

export async function markRowsForDeletion(
  db: D1Database,
  rows: readonly ExpiredSessionRow[],
  now: number,
): Promise<void> {
  await recordAnalyticsErasureRequests(db, rows, now);
}

async function recordDeletionFailure(
  db: D1Database,
  row: ExpiredSessionRow,
  error: unknown,
): Promise<void> {
  const message = (
    error instanceof Error ? error.message : "A session could not be deleted."
  ).slice(0, 500);
  await db
    .prepare(
      `UPDATE session_deletions
      SET last_error = ?
      WHERE project_id = ? AND session_id = ?`,
    )
    .bind(message, row.projectId, row.sessionId)
    .run();
}

async function deleteRowsForSessions(
  db: D1Database,
  rows: readonly ExpiredSessionRow[],
): Promise<number> {
  let rowsDeleted = 0;

  for (const chunk of chunkList(rows, ANALYTICS_ERASURE_BATCH_SIZE)) {
    const placeholders = chunk.map(() => "(?, ?)").join(", ");
    const values = chunk.flatMap((row) => [row.projectId, row.sessionId]);
    const results = await db.batch([
      db
        .prepare(`DELETE FROM session_events WHERE (project_id, session_id) IN (${placeholders})`)
        .bind(...values),
      db
        .prepare(`DELETE FROM sessions WHERE (project_id, session_id) IN (${placeholders})`)
        .bind(...values),
    ]);
    rowsDeleted += results[1]?.meta.changes ?? 0;
  }

  return rowsDeleted;
}
