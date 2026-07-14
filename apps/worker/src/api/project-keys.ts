import { configKvKey, type ProjectConfig } from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
import { sha256Hex } from "../ingest/hash.ts";
import type { SessionAuthContext } from "./auth.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "./http.ts";
import { readStoredProjectConfig } from "./project-config.ts";
import {
  beginActiveKeyCacheWrite,
  finishActiveKeyCacheWrite,
  keyCacheFinalCheckTime,
  repairProjectKeyCache,
  syncRevokedKeyCache,
} from "./project-key-cache.ts";

const KEY_BODY_LIMIT_BYTES = 2 * 1024;
const MAX_ACTIVE_KEYS = 10;
const MAX_KEY_AUDIT_ROWS = 100;
const KEY_NAME_MAX_LENGTH = 64;

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

export interface ProjectKeyAudit {
  id: string;
  name: string;
  keyHashPrefix: string;
  active: boolean;
  createdAt: number;
  createdBy: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
}

export async function getProjectKeys(env: Env, projectId: string): Promise<ProjectKeyAudit[]> {
  await repairProjectKeyCache(env, projectId);
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

export async function createProjectKey(
  request: Request,
  env: Env,
  projectId: string,
  auth: SessionAuthContext | null,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, KEY_BODY_LIMIT_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);

  const name = readKeyName(body.value);
  if (name === null) return jsonError("invalid_key_name", 400);

  if (!(await keyManagementRateLimitAllows(env, projectId, auth))) {
    return jsonError("rate_limited", 429);
  }

  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);

  const database = shardDb(env, 0);
  const secret = createWriteKey();
  const keyHash = await sha256Hex(secret);
  const keyId = `key_${crypto.randomUUID()}`;
  const actorId = auth?.hostedSession.user.id ?? null;
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
    return jsonError(
      counts.total_count >= MAX_KEY_AUDIT_ROWS
        ? "key_history_limit_reached"
        : "active_key_limit_reached",
      409,
    );
  }

  let cacheWriteId: string | null = null;
  try {
    cacheWriteId = await beginActiveKeyCacheWrite(database, keyHash);
    if (cacheWriteId === null) {
      await syncRevokedKeyCache(env, database, keyHash);
      return jsonError("key_was_revoked", 409);
    }
    let cachedConfig = config;
    await env.CONFIG.put(
      configKvKey(keyHash),
      JSON.stringify({ ...cachedConfig, active: true } satisfies ProjectConfig),
    );
    const latestConfig = await readStoredProjectConfig(env, projectId);
    if (latestConfig === null)
      throw new Error("The project was removed while its key was created.");
    if (latestConfig.version !== config.version) {
      cachedConfig = latestConfig;
      await env.CONFIG.put(
        configKvKey(keyHash),
        JSON.stringify({ ...cachedConfig, active: true } satisfies ProjectConfig),
      );
    }

    await database
      .prepare("UPDATE keys SET cache_synced = 0 WHERE id = ? AND project_id = ? AND active = 1")
      .bind(keyId, projectId)
      .run();

    // The key can be revoked after its D1 insert but before this cache work
    // finishes. Keep this as the last cache write from creation so a completed
    // revoke cannot be overwritten by stale active state.
    const current = await database
      .prepare("SELECT active FROM keys WHERE id = ? AND project_id = ?")
      .bind(keyId, projectId)
      .first<{ active: number }>();
    if (current === null) throw new Error("The write key was removed while it was created.");
    if (current.active !== 1) {
      await syncRevokedKeyCache(env, database, keyHash);
      return jsonError("key_was_revoked", 409);
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
      // D1 keeps cache_synced = 0 so the scheduled repair retries this deletion.
    }
    return jsonError("key_cache_unavailable", 503);
  } finally {
    if (cacheWriteId !== null) {
      await finishActiveKeyCacheWrite(database, cacheWriteId);
    }
  }

  const key: ProjectKeyAudit = {
    id: keyId,
    name,
    keyHashPrefix: keyHash.slice(0, 12),
    active: true,
    createdAt,
    createdBy: actorId,
    revokedAt: null,
    revokedBy: null,
  };
  return jsonResponse(
    { key, secret },
    { headers: { "cache-control": "private, no-store", pragma: "no-cache" } },
  );
}

export async function revokeProjectKey(
  env: Env,
  projectId: string,
  keyId: string,
  auth: SessionAuthContext | null,
): Promise<Response> {
  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);

  if (!(await keyManagementRateLimitAllows(env, projectId, auth))) {
    return jsonError("rate_limited", 429);
  }

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
  if (stored === null) return jsonError("key_not_found", 404);

  const revokedAt = stored.revoked_at ?? Date.now();
  const revokedBy = stored.revoked_by ?? auth?.hostedSession.user.id ?? null;
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

  // D1 is the durable source. Deleting the central KV value follows, while
  // edge caches can still serve an older value during their propagation window.
  try {
    await syncRevokedKeyCache(env, database, stored.key_hash);
  } catch {
    return jsonError("key_cache_unavailable", 503);
  }

  return jsonResponse(
    {
      key: {
        ...mapProjectKey(stored),
        active: false,
        revokedAt,
        revokedBy,
      },
    },
    { headers: { "cache-control": "private, no-store" } },
  );
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

async function keyManagementRateLimitAllows(
  env: Env,
  projectId: string,
  auth: SessionAuthContext | null,
): Promise<boolean> {
  if (env.KEY_MANAGEMENT_RATE_LIMITER === undefined) return false;
  const actorId = auth?.hostedSession.user.id ?? "local-token";
  const key = await sha256Hex(`project-key-write:${projectId}:${actorId}`);
  try {
    return (await env.KEY_MANAGEMENT_RATE_LIMITER.limit({ key })).success;
  } catch {
    return false;
  }
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

function readKeyName(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const name = (value as { name?: unknown }).name;
  if (typeof name !== "string" || name.trim() !== name) return null;
  if (name.length < 1 || name.length > KEY_NAME_MAX_LENGTH) return null;
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return null;
  }
  return name;
}

function createWriteKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `or_live_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}
