import { sessionPrefix, startWideEvent, type WideEventOutcome } from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
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
  const wideEvent = startWideEvent("worker", "consumer.sweep");
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

      totals.sessionsDeleted += await deleteRowsForSessions(db, "sessions", rows);
      await deleteRowsForSessions(db, "session_events", rows);

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
  tableName: "sessions" | "session_events",
  rows: readonly ExpiredSessionRow[],
): Promise<number> {
  let rowsDeleted = 0;

  for (const chunk of chunkList(rows, D1_DELETE_CHUNK_SIZE)) {
    const sessionIds = chunk.map((row) => row.sessionId);
    const placeholders = sessionIds.map(() => "?").join(", ");
    const result = await db
      .prepare(`DELETE FROM ${tableName} WHERE session_id IN (${placeholders})`)
      .bind(...sessionIds)
      .run();
    rowsDeleted += result.meta.changes;
  }

  return rowsDeleted;
}
