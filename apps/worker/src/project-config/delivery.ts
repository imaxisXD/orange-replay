import { configKvKey } from "@orange-replay/shared";
import type {
  ProjectConfig,
  ProjectConfigUpdate,
  ProjectKeyAudit,
  StoredProjectConfig,
} from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
import { sha256Hex } from "../ingest/hash.ts";
import { readStoredProjectConfig } from "./storage.ts";

const CACHE_REPAIR_LIMIT = 200;
const FINAL_CACHE_CHECK_DELAY_MS = 15 * 60 * 1_000;
const KEY_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_KEYS = 10;
const MAX_KEY_AUDIT_ROWS = 100;

interface KeyRow {
  [key: string]: unknown;
  key_hash: string;
  active: number;
}

interface ActiveKeyRow {
  [key: string]: unknown;
  active: number;
}

interface ActiveCacheRepairRow {
  [key: string]: unknown;
  key_hash: string;
  project_id: string;
  cache_final_check_at: number | null;
}

interface KeyHashRow {
  [key: string]: unknown;
  key_hash: string;
}

interface ProjectKeyRow {
  [key: string]: unknown;
  id: string;
  name: string;
  key_hash_prefix: string;
  active: number;
  created_at: number;
  created_by: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

interface StoredProjectKeyRow extends ProjectKeyRow {
  key_hash: string;
}

interface ProjectKeyCounts {
  [key: string]: unknown;
  active_count: number;
  total_count: number;
}

export type SaveProjectConfigResult =
  | { status: "saved"; config: StoredProjectConfig }
  | { status: "not_found" }
  | { status: "version_conflict" };

export type CreateProjectWriteKeyResult =
  | { status: "created"; key: ProjectKeyAudit; secret: string }
  | { status: "not_found" }
  | { status: "active_key_limit_reached" }
  | { status: "key_history_limit_reached" }
  | { status: "key_was_revoked" }
  | { status: "key_cache_unavailable" };

export type RevokeProjectWriteKeyResult =
  | { status: "revoked"; key: ProjectKeyAudit }
  | { status: "key_not_found" }
  | { status: "key_cache_unavailable" };

export interface ProjectConfigDeliveryMaintenance {
  activeRepaired: number;
  repaired: number;
  rechecked: number;
  auditRowsDeleted: number;
}

export async function saveProjectConfig(
  env: Env,
  projectId: string,
  update: ProjectConfigUpdate,
): Promise<SaveProjectConfigResult> {
  const database = shardDb(env, 0);
  const current = await readStoredProjectConfig(env, projectId);
  if (current === null) return { status: "not_found" };
  const serializedMaskRules = JSON.stringify(update.maskRules);

  const result = await database
    .prepare(
      `UPDATE projects
        SET sample_rate = ?,
          retention_days = ?,
          allowed_origins = ?,
          mask_policy_version = CASE
            WHEN mask_rules = ? THEN mask_policy_version
            ELSE mask_policy_version + 1
          END,
          mask_rules = ?,
          capture_toggles = ?,
          config_version = config_version + 1
        WHERE id = ? AND config_version = ?`,
    )
    .bind(
      update.sampleRate,
      update.retentionDays,
      JSON.stringify(update.allowedOrigins),
      serializedMaskRules,
      serializedMaskRules,
      JSON.stringify(update.capture),
      projectId,
      update.expectedVersion,
    )
    .run();

  if ((result.meta.changes ?? 0) < 1) {
    if ((await readStoredProjectConfig(env, projectId)) === null) {
      return { status: "not_found" };
    }
    return { status: "version_conflict" };
  }

  const stored = await readStoredProjectConfig(env, projectId);
  if (stored === null) throw new Error("project config was not readable after update");

  // D1 is already durable here. Any failed KV delivery leaves every active key
  // pending so the scheduled repair can finish the same configuration version.
  await deliverProjectConfig(env, stored);
  return { status: "saved", config: stored };
}

export async function listProjectWriteKeys(
  env: Env,
  projectId: string,
): Promise<ProjectKeyAudit[]> {
  await repairRevokedProjectKeyDelivery(env, projectId);
  const rows = await shardDb(env, 0)
    .prepare(
      `SELECT
        id,
        name,
        substr(key_hash, 1, 12) AS key_hash_prefix,
        active,
        created_at,
        created_by,
        revoked_at,
        revoked_by
      FROM keys
      WHERE project_id = ?
      ORDER BY created_at DESC, id ASC
      LIMIT ?`,
    )
    .bind(projectId, MAX_KEY_AUDIT_ROWS)
    .all<ProjectKeyRow>();

  return (rows.results ?? []).map(mapProjectKey);
}

export async function createProjectWriteKey(
  env: Env,
  projectId: string,
  name: string,
  actorId: string | null,
): Promise<CreateProjectWriteKeyResult> {
  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return { status: "not_found" };

  const database = shardDb(env, 0);
  const secret = createWriteKey();
  const keyHash = await sha256Hex(secret);
  const keyId = `key_${crypto.randomUUID()}`;
  const createdAt = Date.now();
  const finalCacheCheckAt = keyCacheFinalCheckTime(createdAt);

  const created = await database
    .prepare(
      `INSERT INTO keys
        (id, key_hash, project_id, name, active, created_at, created_by, revoked_at,
          revoked_by, cache_synced, cache_final_check_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (
          SELECT COUNT(*) FROM keys WHERE project_id = ? AND active = 1
        ) < ? AND (
          SELECT COUNT(*) FROM keys WHERE project_id = ?
        ) < ?`,
    )
    .bind(
      keyId,
      keyHash,
      projectId,
      name,
      1,
      createdAt,
      actorId,
      null,
      null,
      0,
      finalCacheCheckAt,
      projectId,
      MAX_ACTIVE_KEYS,
      projectId,
      MAX_KEY_AUDIT_ROWS,
    )
    .run();
  if ((created.meta.changes ?? 0) < 1) {
    const counts = await readProjectKeyCounts(database, projectId);
    return {
      status:
        counts.total_count >= MAX_KEY_AUDIT_ROWS
          ? "key_history_limit_reached"
          : "active_key_limit_reached",
    };
  }

  let cacheWriteId: string | null = null;
  try {
    cacheWriteId = await beginActiveKeyCacheWrite(database, keyHash);
    if (cacheWriteId === null) {
      await syncRevokedKeyCache(env, database, keyHash);
      return { status: "key_was_revoked" };
    }

    let cachedConfig = config;
    await writeKeyConfig(env, keyHash, cachedConfig);
    const latestConfig = await readStoredProjectConfig(env, projectId);
    if (latestConfig === null) {
      throw new Error("The project was removed while its key was created.");
    }
    if (latestConfig.version !== config.version) {
      cachedConfig = latestConfig;
      await writeKeyConfig(env, keyHash, cachedConfig);
    }

    await database
      .prepare("UPDATE keys SET cache_synced = 0 WHERE id = ? AND project_id = ? AND active = 1")
      .bind(keyId, projectId)
      .run();

    // Creation can race revocation. This is the final KV write in creation, so
    // the durable active check must happen after it.
    const current = await database
      .prepare("SELECT active FROM keys WHERE id = ? AND project_id = ?")
      .bind(keyId, projectId)
      .first<ActiveKeyRow>();
    if (current === null) throw new Error("The write key was removed while it was created.");
    if (current.active !== 1) {
      await syncRevokedKeyCache(env, database, keyHash);
      return { status: "key_was_revoked" };
    }

    const synced = await database
      .prepare(
        `UPDATE keys
        SET cache_synced = 1
        WHERE id = ?
          AND project_id = ?
          AND active = 1
          AND EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = keys.project_id AND projects.config_version = ?
          )`,
      )
      .bind(keyId, projectId, cachedConfig.version)
      .run();
    if ((synced.meta.changes ?? 0) < 1) {
      await env.CONFIG.delete(configKvKey(keyHash));
    }
  } catch {
    const stoppedAt = Date.now();
    await database
      .prepare(
        `UPDATE keys
          SET active = 0,
            revoked_at = COALESCE(revoked_at, ?),
            revoked_by = COALESCE(revoked_by, ?),
            cache_synced = 0,
            cache_final_check_at = ?
          WHERE id = ? AND project_id = ?`,
      )
      .bind(stoppedAt, actorId, keyCacheFinalCheckTime(stoppedAt), keyId, projectId)
      .run();
    try {
      await syncRevokedKeyCache(env, database, keyHash);
    } catch {
      // D1 keeps this delivery pending for the scheduled repair.
    }
    return { status: "key_cache_unavailable" };
  } finally {
    if (cacheWriteId !== null) {
      await finishActiveKeyCacheWrite(database, cacheWriteId);
    }
  }

  return {
    status: "created",
    key: {
      id: keyId,
      name,
      keyHashPrefix: keyHash.slice(0, 12),
      active: true,
      createdAt,
      createdBy: actorId,
      revokedAt: null,
      revokedBy: null,
    },
    secret,
  };
}

export async function revokeProjectWriteKey(
  env: Env,
  projectId: string,
  keyId: string,
  actorId: string | null,
): Promise<RevokeProjectWriteKeyResult> {
  const database = shardDb(env, 0);
  const stored = await database
    .prepare(
      `SELECT
        id,
        name,
        key_hash,
        substr(key_hash, 1, 12) AS key_hash_prefix,
        active,
        created_at,
        created_by,
        revoked_at,
        revoked_by
      FROM keys
      WHERE id = ? AND project_id = ?`,
    )
    .bind(keyId, projectId)
    .first<StoredProjectKeyRow>();
  if (stored === null) return { status: "key_not_found" };

  const revokedAt = stored.revoked_at ?? Date.now();
  const revokedBy = stored.revoked_by ?? actorId;
  await database
    .prepare(
      `UPDATE keys
        SET active = 0,
          revoked_at = COALESCE(revoked_at, ?),
          revoked_by = COALESCE(revoked_by, ?),
          cache_synced = 0,
          cache_final_check_at = ?
        WHERE id = ? AND project_id = ?`,
    )
    .bind(revokedAt, revokedBy, keyCacheFinalCheckTime(Date.now()), keyId, projectId)
    .run();

  // Revocation is durable before KV deletion. Existing KV edge copies may
  // remain readable during Cloudflare's propagation window.
  try {
    await syncRevokedKeyCache(env, database, stored.key_hash);
  } catch {
    return { status: "key_cache_unavailable" };
  }

  return {
    status: "revoked",
    key: {
      ...mapProjectKey(stored),
      active: false,
      revokedAt,
      revokedBy,
    },
  };
}

export async function maintainProjectConfigDelivery(
  env: Env,
  now = Date.now(),
): Promise<ProjectConfigDeliveryMaintenance> {
  const activeRepaired = await repairActiveProjectKeyCache(env, now);
  const revoked = await maintainRevokedProjectKeyCache(env, now);
  return { activeRepaired, ...revoked };
}

async function deliverProjectConfig(env: Env, config: StoredProjectConfig): Promise<void> {
  const database = shardDb(env, 0);
  await database
    .prepare(
      `UPDATE keys
      SET cache_synced = 0, cache_final_check_at = ?
      WHERE project_id = ? AND active = 1`,
    )
    .bind(keyCacheFinalCheckTime(Date.now()), config.projectId)
    .run();
  const rows = await database
    .prepare("SELECT key_hash, active FROM keys WHERE project_id = ?")
    .bind(config.projectId)
    .all<KeyRow>();

  for (const row of rows.results ?? []) {
    if (row.active === 1) {
      await refreshActiveKeyCache(env, database, row.key_hash, config, false);
    } else {
      await syncRevokedKeyCache(env, database, row.key_hash);
    }
  }
}

async function repairActiveProjectKeyCache(env: Env, now: number): Promise<number> {
  const database = shardDb(env, 0);
  const rows = await database
    .prepare(
      `SELECT key_hash, project_id, cache_final_check_at
      FROM keys
      WHERE active = 1
        AND (
          cache_synced = 0
          OR (cache_final_check_at IS NOT NULL AND cache_final_check_at <= ?)
          OR (
            cache_final_check_at IS NULL
            AND EXISTS (SELECT 1 FROM key_cache_writes w WHERE w.key_hash = keys.key_hash)
          )
        )
      ORDER BY
        CASE WHEN cache_synced = 0 THEN 0 ELSE 1 END,
        cache_final_check_at ASC,
        key_hash ASC
      LIMIT ?`,
    )
    .bind(now, CACHE_REPAIR_LIMIT)
    .all<ActiveCacheRepairRow>();

  const configs = new Map<string, StoredProjectConfig | null>();
  for (const row of rows.results ?? []) {
    let config = configs.get(row.project_id);
    if (config === undefined) {
      config = await readStoredProjectConfig(env, row.project_id);
      configs.set(row.project_id, config);
    }
    if (config === null) {
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
          WHERE key_hash = ? AND active = 1`,
        )
        .bind(keyCacheFinalCheckTime(now), row.key_hash)
        .run();
      continue;
    }

    const finalCheckIsDue = row.cache_final_check_at !== null && row.cache_final_check_at <= now;
    await refreshActiveKeyCache(env, database, row.key_hash, config, finalCheckIsDue);
  }

  return rows.results?.length ?? 0;
}

async function refreshActiveKeyCache(
  env: Env,
  database: D1Database,
  keyHash: string,
  config: StoredProjectConfig,
  clearFinalCheck: boolean,
): Promise<void> {
  const writeId = await beginActiveKeyCacheWrite(database, keyHash);
  if (writeId === null) {
    await syncRevokedKeyCache(env, database, keyHash);
    return;
  }

  try {
    await database
      .prepare("UPDATE keys SET cache_synced = 0 WHERE key_hash = ? AND active = 1")
      .bind(keyHash)
      .run();
    await writeKeyConfig(env, keyHash, config);

    // Another writer may have completed while this older value was in flight.
    // Mark pending again before the version-guarded final state change.
    await database
      .prepare("UPDATE keys SET cache_synced = 0 WHERE key_hash = ? AND active = 1")
      .bind(keyHash)
      .run();
    const followUpAt = keyCacheFinalCheckTime(Date.now());
    const synced = await database
      .prepare(
        `UPDATE keys
        SET cache_synced = 1,
          cache_final_check_at = CASE
          WHEN EXISTS (
            SELECT 1 FROM key_cache_writes w
            WHERE w.key_hash = keys.key_hash AND w.id <> ?
          ) THEN ?
          WHEN ? = 1 THEN NULL
          ELSE cache_final_check_at
        END
        WHERE key_hash = ?
          AND active = 1
          AND EXISTS (
            SELECT 1 FROM projects
            WHERE projects.id = keys.project_id AND projects.config_version = ?
          )`,
      )
      .bind(writeId, followUpAt, clearFinalCheck ? 1 : 0, keyHash, config.version)
      .run();
    if ((synced.meta.changes ?? 0) < 1) {
      await env.CONFIG.delete(configKvKey(keyHash));
    }

    const current = await database
      .prepare("SELECT active FROM keys WHERE key_hash = ?")
      .bind(keyHash)
      .first<ActiveKeyRow>();
    if (current !== null && current.active !== 1) {
      await syncRevokedKeyCache(env, database, keyHash);
    }
  } finally {
    await finishActiveKeyCacheWrite(database, writeId);
  }
}

async function repairRevokedProjectKeyDelivery(env: Env, projectId: string): Promise<number> {
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

async function maintainRevokedProjectKeyCache(
  env: Env,
  now: number,
): Promise<Omit<ProjectConfigDeliveryMaintenance, "activeRepaired">> {
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

async function beginActiveKeyCacheWrite(
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

async function finishActiveKeyCacheWrite(database: D1Database, writeId: string): Promise<void> {
  await database.prepare("DELETE FROM key_cache_writes WHERE id = ?").bind(writeId).run();
}

async function syncRevokedKeyCache(env: Env, database: D1Database, keyHash: string): Promise<void> {
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

async function writeKeyConfig(
  env: Env,
  keyHash: string,
  config: StoredProjectConfig,
): Promise<void> {
  const cachedConfig: ProjectConfig = { ...config, active: true };
  await env.CONFIG.put(configKvKey(keyHash), JSON.stringify(cachedConfig));
}

async function readProjectKeyCounts(
  database: D1Database,
  projectId: string,
): Promise<ProjectKeyCounts> {
  const counts = await database
    .prepare(
      `SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_count
      FROM keys
      WHERE project_id = ?`,
    )
    .bind(projectId)
    .first<ProjectKeyCounts>();
  return counts ?? { total_count: 0, active_count: 0 };
}

function mapProjectKey(row: ProjectKeyRow): ProjectKeyAudit {
  return {
    id: row.id,
    name: row.name,
    keyHashPrefix: row.key_hash_prefix,
    active: row.active === 1,
    createdAt: row.created_at,
    createdBy: row.created_by,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

function keyCacheFinalCheckTime(now: number): number {
  return now + FINAL_CACHE_CHECK_DELAY_MS;
}

function createWriteKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `or_live_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

/** Dev-test access to race controls; production callers use the deep interface above. */
export const projectConfigDeliveryTestHooks = {
  beginActiveKeyCacheWrite,
  finishActiveKeyCacheWrite,
  keyCacheFinalCheckTime,
  repairActiveProjectKeyCache: (env: Env, now = Date.now()) =>
    repairActiveProjectKeyCache(env, now),
  syncRevokedKeyCache,
};
