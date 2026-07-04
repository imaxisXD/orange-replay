import {
  sessionPrefix,
  startWideEvent,
  uuidv7,
  type WideEventOutcome,
} from "@orange-replay/shared";
import { isValidPathId } from "../api/helpers.ts";
import { setWorkerLoggerVersion, shardDb, type Env } from "../env.ts";
import { chunkList } from "./helpers.ts";

const SESSION_SELECT_LIMIT = 200;
const R2_DELETE_LIMIT = 1_000;
const D1_DELETE_CHUNK_SIZE = 100;

interface ExpiredSessionRow {
  sessionId: string;
  projectId: string;
}

interface SweepTotals {
  sessionsDeleted: number;
  objectsDeleted: number;
}

export async function sweepExpiredSessions(env: Env): Promise<void> {
  setWorkerLoggerVersion(env);
  const requestId = uuidv7();
  const wideEvent = startWideEvent("worker", "consumer.sweep", requestId);
  const totals: SweepTotals = { sessionsDeleted: 0, objectsDeleted: 0 };
  let outcome: WideEventOutcome = "success";

  try {
    const db = shardDb(env, 0);
    const now = Date.now();

    for (;;) {
      const rows = await selectExpiredSessions(db, now);
      if (rows.length === 0) break;

      for (const row of rows) {
        totals.objectsDeleted += await deleteSessionObjects(env.RECORDINGS, row);
      }

      totals.sessionsDeleted += await deleteRowsForSessions(db, rows);

      if (rows.length < SESSION_SELECT_LIMIT) break;
    }
  } catch (err) {
    outcome = "server_error";
    wideEvent.fail(err);
    throw err;
  } finally {
    wideEvent.set({
      sessions_deleted: totals.sessionsDeleted,
      objects_deleted: totals.objectsDeleted,
    });
    wideEvent.emit(outcome);
  }
}

async function selectExpiredSessions(db: D1Database, now: number): Promise<ExpiredSessionRow[]> {
  const result = await db
    .prepare(
      `SELECT session_id AS sessionId, project_id AS projectId
      FROM sessions
      WHERE expires_at < ?
      LIMIT 200`,
    )
    .bind(now)
    .all<ExpiredSessionRow>();
  return result.results;
}

async function deleteSessionObjects(bucket: R2Bucket, row: ExpiredSessionRow): Promise<number> {
  if (!isValidPathId(row.projectId) || !isValidPathId(row.sessionId)) {
    return 0;
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

async function deleteRowsForSessions(
  db: D1Database,
  rows: readonly ExpiredSessionRow[],
): Promise<number> {
  let rowsDeleted = 0;

  for (const chunk of chunkList(rows, D1_DELETE_CHUNK_SIZE)) {
    const sessionIds = chunk.map((row) => row.sessionId);
    const placeholders = sessionIds.map(() => "?").join(", ");
    const results = await db.batch([
      db
        .prepare(`DELETE FROM session_events WHERE session_id IN (${placeholders})`)
        .bind(...sessionIds),
      db.prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`).bind(...sessionIds),
    ]);
    rowsDeleted += results[1]?.meta.changes ?? 0;
  }

  return rowsDeleted;
}
