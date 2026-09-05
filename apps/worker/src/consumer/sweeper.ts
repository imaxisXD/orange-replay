import {
  analyticsSidecarKey,
  sessionPrefix,
  startWideEvent,
  uuidv7,
  type WideEventOutcome,
} from "@orange-replay/shared";
import { isValidPathId } from "../query/session-query.ts";
import {
  ANALYTICS_ERASURE_BATCH_SIZE,
  queueDeletionExportsFromJournal,
  recordAnalyticsErasureRequests,
} from "../analytics/erasure-lifecycle.ts";
import { analyticsExportEnabled, setWorkerLoggerVersion, shardDb, type Env } from "../env.ts";
import { chunkList } from "./helpers.ts";
import { readFinalizationJob } from "./finalization-recovery.ts";

const SESSION_SELECT_LIMIT = 200;
const R2_DELETE_LIMIT = 1_000;
const REPLAY_ASSET_DELETE_GRACE_MS = 24 * 60 * 60 * 1_000;
const REPLAY_ASSET_BUDGET_HISTORY_DAYS = 7;

export interface ExpiredSessionRow {
  sessionId: string;
  projectId: string;
  startedAt: number;
  deleteReason: "recording_retention_expired" | "delete_requested";
  requiresWarehouseTombstone: number;
  keepAnalyticsSidecar: number;
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
          const job = await readFinalizationJob(db, { ...row, shard: 0 });
          if (job !== null) {
            const repair = await env.SESSION.get(
              env.SESSION.idFromString(job.object_id),
            ).repairFinalization({
              projectId: row.projectId,
              sessionId: row.sessionId,
              shard: job.shard,
            });
            if (!repair.complete) continue;
            await db
              .prepare(
                "DELETE FROM session_finalization_jobs WHERE project_id = ? AND session_id = ?",
              )
              .bind(row.projectId, row.sessionId)
              .run();
          }
          const deletion = await deleteSessionObjects(env.RECORDINGS, row);
          totals.objectsDeleted += deletion.objectsDeleted;
          if (deletion.complete) safelyDeleted.push(row);
        } catch (error) {
          totals.sessionsFailed += 1;
          firstDeleteError ??= error;
          await recordDeletionFailure(db, row, error);
        }
      }

      totals.sessionsDeleted += await deleteRowsForSessions(db, safelyDeleted);

      if (rows.length < SESSION_SELECT_LIMIT || safelyDeleted.length === 0) break;
    }

    totals.objectsDeleted += await sweepOrphanReplayAssets(env, db);

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

async function sweepOrphanReplayAssets(env: Env, db: D1Database): Promise<number> {
  const deleteBefore = Date.now() - REPLAY_ASSET_DELETE_GRACE_MS;
  await db
    .prepare(
      `DELETE FROM replay_project_assets
      WHERE created_at < ? AND NOT EXISTS (
        SELECT 1 FROM replay_session_assets s
        WHERE s.project_id = replay_project_assets.project_id
          AND s.asset_hash = replay_project_assets.asset_hash
      )`,
    )
    .bind(deleteBefore)
    .run();
  await db
    .prepare(
      `DELETE FROM replay_asset_urls
      WHERE NOT EXISTS (
        SELECT 1 FROM replay_project_assets p
        WHERE p.project_id = replay_asset_urls.project_id
          AND p.asset_hash = replay_asset_urls.asset_hash
      )`,
    )
    .run();
  const oldestBudgetDay = new Date(
    Date.now() - REPLAY_ASSET_BUDGET_HISTORY_DAYS * 24 * 60 * 60 * 1_000,
  )
    .toISOString()
    .slice(0, 10);
  await db
    .prepare(`DELETE FROM replay_asset_fetch_budgets WHERE day < ?`)
    .bind(oldestBudgetDay)
    .run();
  await db.prepare(`DELETE FROM replay_asset_attempts WHERE day < ?`).bind(oldestBudgetDay).run();
  const rows = await db
    .prepare(
      `SELECT asset_hash AS assetHash, r2_key AS r2Key, content_type AS contentType,
        bytes, created_at AS createdAt
      FROM replay_asset_objects o
      WHERE NOT EXISTS (
        SELECT 1 FROM replay_project_assets p WHERE p.asset_hash = o.asset_hash
      )
        AND created_at < ?
      ORDER BY created_at
      LIMIT 200`,
    )
    .bind(deleteBefore)
    .all<{
      assetHash: string;
      r2Key: string;
      contentType: string;
      bytes: number;
      createdAt: number;
    }>();
  let deleted = 0;
  for (const row of rows.results) {
    const removed = await db
      .prepare(
        `DELETE FROM replay_asset_objects
        WHERE asset_hash = ? AND NOT EXISTS (
          SELECT 1 FROM replay_project_assets WHERE asset_hash = ?
        )`,
      )
      .bind(row.assetHash, row.assetHash)
      .run();
    if ((removed.meta.changes ?? 0) === 0) continue;
    try {
      await env.RECORDINGS.delete(row.r2Key);
      deleted += 1;
    } catch (error) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO replay_asset_objects
            (asset_hash, r2_key, content_type, bytes, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(row.assetHash, row.r2Key, row.contentType, row.bytes, row.createdAt)
        .run();
      throw error;
    }
  }
  return deleted;
}

export async function selectExpiredSessions(
  db: D1Database,
  now: number,
): Promise<ExpiredSessionRow[]> {
  const result = await db
    .prepare(
      `SELECT sessions.session_id AS sessionId, sessions.project_id AS projectId,
        sessions.started_at AS startedAt,
        CASE
          WHEN COALESCE(d.delete_analytics, 0) = 1 THEN 'delete_requested'
          WHEN sessions.expires_at < ? THEN 'recording_retention_expired'
          ELSE 'delete_requested'
        END AS deleteReason,
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
        END AS requiresWarehouseTombstone,
        CASE
          WHEN COALESCE(d.delete_analytics, 0) = 0
            AND sessions.expires_at < ?
            AND EXISTS (
              SELECT 1
              FROM analytics_export_outbox pending
              WHERE pending.project_id = sessions.project_id
                AND pending.session_id = sessions.session_id
                AND pending.record_kind = 'session'
                AND pending.sent_at IS NULL
                AND json_extract(pending.payload_json, '$.analytics_sidecar_key') IS NOT NULL
            )
          THEN 1
          ELSE 0
        END AS keepAnalyticsSidecar
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
    .bind(now, now, now)
    .all<ExpiredSessionRow>();
  return result.results;
}

export async function deleteSessionObjects(
  bucket: R2Bucket,
  row: ExpiredSessionRow,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<{ complete: boolean; objectsDeleted: number }> {
  if (!isValidPathId(row.projectId) || !isValidPathId(row.sessionId)) {
    throw new Error("The session has an invalid storage id, so its data was not deleted.");
  }

  const prefix = `${sessionPrefix(row.projectId, row.sessionId)}/`;
  let cursor: string | undefined;
  let objectsDeleted = 0;
  let keptSidecar = false;
  let pages = 0;
  let morePages = false;
  const sidecarKey = analyticsSidecarKey(row.projectId, row.sessionId);

  for (;;) {
    const listed = await bucket.list({ prefix, cursor, limit: R2_DELETE_LIMIT });
    pages += 1;
    const keys = listed.objects.flatMap((object) => {
      if (row.keepAnalyticsSidecar === 1 && object.key === sidecarKey) {
        keptSidecar = true;
        return [];
      }
      return [object.key];
    });

    for (const keyChunk of chunkList(keys, R2_DELETE_LIMIT)) {
      if (keyChunk.length > 0) {
        await bucket.delete(keyChunk);
        objectsDeleted += keyChunk.length;
      }
    }

    if (!listed.truncated) break;
    if (pages >= maxPages) {
      morePages = true;
      break;
    }
    cursor = listed.cursor;
  }

  if (row.keepAnalyticsSidecar === 1 && !keptSidecar && !morePages) {
    throw new Error("The pending analytics sidecar is missing, so cleanup was paused.");
  }
  return { complete: !keptSidecar && !morePages, objectsDeleted };
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
