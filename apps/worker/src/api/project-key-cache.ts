import { configKvKey } from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";

const CACHE_REPAIR_LIMIT = 200;
const FINAL_CACHE_CHECK_DELAY_MS = 15 * 60 * 1_000;
const KEY_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

interface KeyHashRow {
  [key: string]: unknown;
  key_hash: string;
}

export interface ProjectKeyCacheMaintenance {
  repaired: number;
  rechecked: number;
  auditRowsDeleted: number;
}

export async function beginActiveKeyCacheWrite(
  database: D1Database,
  keyHash: string,
): Promise<string | null> {
  const writeId = `cache_write_${crypto.randomUUID()}`;
  const followUpAt = keyCacheFinalCheckTime(Date.now());
  const [result] = await database.batch([
    database
      .prepare(
        `INSERT INTO key_cache_writes (id, key_hash, started_at)
      SELECT ?, key_hash, ?
      FROM keys
      WHERE key_hash = ? AND active = 1`,
      )
      .bind(writeId, Date.now(), keyHash),
    database
      .prepare(
        `UPDATE keys
        SET cache_final_check_at = CASE
          WHEN cache_final_check_at IS NULL OR cache_final_check_at > ? THEN ?
          ELSE cache_final_check_at
        END
        WHERE key_hash = ?
          AND active = 1
          AND EXISTS (
            SELECT 1 FROM key_cache_writes w
            WHERE w.id = ? AND w.key_hash = keys.key_hash
          )`,
      )
      .bind(followUpAt, followUpAt, keyHash, writeId),
  ]);
  return (result?.meta.changes ?? 0) > 0 ? writeId : null;
}

export async function finishActiveKeyCacheWrite(
  database: D1Database,
  writeId: string,
): Promise<void> {
  await database.prepare("DELETE FROM key_cache_writes WHERE id = ?").bind(writeId).run();
}

export async function syncRevokedKeyCache(
  env: Env,
  database: D1Database,
  keyHash: string,
): Promise<void> {
  // Mark the delete as pending before touching KV. If this delete fails, or a
  // stale settings request writes after an earlier delete, a later repair can
  // see durable work left in D1.
  await database
    .prepare("UPDATE keys SET cache_synced = 0 WHERE key_hash = ? AND active = 0")
    .bind(keyHash)
    .run();
  await env.CONFIG.delete(configKvKey(keyHash));
  await database
    .prepare("UPDATE keys SET cache_synced = 1 WHERE key_hash = ? AND active = 0")
    .bind(keyHash)
    .run();
}

export async function repairProjectKeyCache(env: Env, projectId: string): Promise<number> {
  const database = shardDb(env, 0);
  const now = Date.now();
  const pending = await database
    .prepare(
      `SELECT key_hash
      FROM keys
      WHERE project_id = ? AND active = 0 AND cache_synced = 0
      ORDER BY revoked_at ASC, key_hash ASC
      LIMIT ?`,
    )
    .bind(projectId, CACHE_REPAIR_LIMIT)
    .all<KeyHashRow>();
  const repaired = await repairRows(env, database, pending.results ?? []);

  const due = await database
    .prepare(
      `SELECT key_hash
      FROM keys
      WHERE project_id = ?
        AND active = 0
        AND (
          (cache_final_check_at IS NOT NULL AND cache_final_check_at <= ?)
          OR (
            cache_final_check_at IS NULL
            AND EXISTS (SELECT 1 FROM key_cache_writes w WHERE w.key_hash = keys.key_hash)
          )
        )
      ORDER BY cache_final_check_at ASC, key_hash ASC
      LIMIT ?`,
    )
    .bind(projectId, now, CACHE_REPAIR_LIMIT)
    .all<KeyHashRow>();
  const rechecked = await finishRows(env, database, due.results ?? [], now);
  return repaired + rechecked;
}

export async function maintainProjectKeyCache(
  env: Env,
  now = Date.now(),
): Promise<ProjectKeyCacheMaintenance> {
  const database = shardDb(env, 0);
  const pending = await database
    .prepare(
      `SELECT key_hash
      FROM keys
      WHERE active = 0 AND cache_synced = 0
      ORDER BY revoked_at ASC, key_hash ASC
      LIMIT ?`,
    )
    .bind(CACHE_REPAIR_LIMIT)
    .all<KeyHashRow>();

  const repaired = await repairRows(env, database, pending.results ?? []);

  // Every revocation keeps a durable final check. It is not cleared until a
  // later KV delete succeeds, so failures and large backlogs remain eligible.
  const due = await database
    .prepare(
      `SELECT key_hash
      FROM keys
      WHERE active = 0
        AND (
          (cache_final_check_at IS NOT NULL AND cache_final_check_at <= ?)
          OR (
            cache_final_check_at IS NULL
            AND EXISTS (SELECT 1 FROM key_cache_writes w WHERE w.key_hash = keys.key_hash)
          )
        )
      ORDER BY cache_final_check_at ASC, key_hash ASC
      LIMIT ?`,
    )
    .bind(now, CACHE_REPAIR_LIMIT)
    .all<KeyHashRow>();
  const rechecked = await finishRows(env, database, due.results ?? [], now);

  const expired = await database
    .prepare(
      `SELECT key_hash
      FROM keys
      WHERE active = 0
        AND cache_synced = 1
        AND revoked_at < ?
        AND NOT EXISTS (SELECT 1 FROM key_cache_writes w WHERE w.key_hash = keys.key_hash)
      ORDER BY revoked_at ASC, key_hash ASC
      LIMIT ?`,
    )
    .bind(now - KEY_AUDIT_RETENTION_MS, CACHE_REPAIR_LIMIT)
    .all<KeyHashRow>();

  let auditRowsDeleted = 0;
  for (const row of expired.results ?? []) {
    await env.CONFIG.delete(configKvKey(row.key_hash));
    const result = await database
      .prepare("DELETE FROM keys WHERE key_hash = ? AND active = 0 AND cache_synced = 1")
      .bind(row.key_hash)
      .run();
    auditRowsDeleted += result.meta.changes ?? 0;
  }

  return { repaired, rechecked, auditRowsDeleted };
}

async function repairRows(
  env: Env,
  database: D1Database,
  rows: readonly KeyHashRow[],
): Promise<number> {
  for (const row of rows) {
    await syncRevokedKeyCache(env, database, row.key_hash);
  }
  return rows.length;
}

async function finishRows(
  env: Env,
  database: D1Database,
  rows: readonly KeyHashRow[],
  now: number,
): Promise<number> {
  const followUpAt = keyCacheFinalCheckTime(now);
  for (const row of rows) {
    await database
      .prepare("UPDATE keys SET cache_synced = 0 WHERE key_hash = ? AND active = 0")
      .bind(row.key_hash)
      .run();
    await env.CONFIG.delete(configKvKey(row.key_hash));
    await database
      .prepare(
        `UPDATE keys
        SET cache_synced = 1,
          cache_final_check_at = CASE
            WHEN EXISTS (
              SELECT 1 FROM key_cache_writes w WHERE w.key_hash = keys.key_hash
            ) THEN ?
            ELSE NULL
          END
        WHERE key_hash = ? AND active = 0`,
      )
      .bind(followUpAt, row.key_hash)
      .run();
  }
  return rows.length;
}

export function keyCacheFinalCheckTime(now: number): number {
  return now + FINAL_CACHE_CHECK_DELAY_MS;
}
