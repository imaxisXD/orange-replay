import { buildDeletionRecord, serializeAnalyticsPayload } from "./export-record.ts";

const JOURNAL_BATCH_SIZE = 200;
const MAX_JOURNAL_PASSES = 10;

interface DeletionJobRow {
  projectId: string;
  sessionId: string;
  requestedAt: number;
  deleteReason: string;
}

/** Queues durable warehouse tombstones that survived an earlier export outage. */
export async function queueDeletionExportsFromJournal(
  db: D1Database,
  now = Date.now(),
): Promise<number> {
  const safeNow = checkedTime(now);
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
      .all<DeletionJobRow>();
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

function checkedTime(now: number): number {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new Error("Analytics deletion repair has an invalid time.");
  }
  return now;
}
