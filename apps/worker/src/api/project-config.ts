import {
  captureTogglesSchema,
  configKvKey,
  maskRulesSchema,
  projectConfigUpdateSchema,
  storedProjectConfigSchema,
} from "@orange-replay/shared";
import type {
  CaptureToggles,
  MaskRule,
  ProjectConfig,
  ProjectConfigUpdate,
  StoredProjectConfig,
} from "@orange-replay/shared";
import { shardDb } from "../env.ts";
import type { Env } from "../env.ts";
import {
  beginActiveKeyCacheWrite,
  finishActiveKeyCacheWrite,
  keyCacheFinalCheckTime,
  syncRevokedKeyCache,
} from "./project-key-cache.ts";

const CACHE_REPAIR_LIMIT = 200;

const defaultCapture: CaptureToggles = {
  heatmaps: false,
  console: false,
  network: false,
  canvas: false,
};

const projectConfigColumns = [
  "ALTER TABLE projects ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE projects ADD COLUMN mask_rules TEXT NOT NULL DEFAULT '[]'",
  `ALTER TABLE projects ADD COLUMN capture_toggles TEXT NOT NULL DEFAULT '{"heatmaps":false,"console":false,"network":false,"canvas":false}'`,
] as const;
let projectConfigColumnsEnsured = false;
let projectConfigColumnsPending: Promise<void> | undefined;

const projectConfigSelect = `
  SELECT
    p.id AS projectId,
    p.org_id AS orgId,
    o.shard AS shard,
    p.retention_days AS retentionDays,
    p.jurisdiction AS jurisdiction,
    p.sample_rate AS sampleRate,
    p.allowed_origins AS allowedOrigins,
    p.mask_policy_version AS maskPolicyVersion,
    p.mask_rules AS maskRules,
    p.capture_toggles AS capture,
    p.quota_state AS quotaState,
    p.config_version AS version,
    (SELECT COUNT(*) FROM keys k WHERE k.project_id = p.id AND k.active = 1) AS activeKeyCount
  FROM projects p
  JOIN orgs o ON o.id = p.org_id
  WHERE p.id = ?
`;

interface ProjectConfigRow {
  [key: string]: unknown;
  projectId: unknown;
  orgId: unknown;
  shard: unknown;
  retentionDays: unknown;
  jurisdiction: unknown;
  sampleRate: unknown;
  allowedOrigins: unknown;
  maskPolicyVersion: unknown;
  maskRules: unknown;
  capture: unknown;
  quotaState: unknown;
  version: unknown;
  activeKeyCount: unknown;
}

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

export function parseProjectConfigUpdate(
  input: unknown,
): { ok: true; value: ProjectConfigUpdate } | { ok: false; error: string } {
  const parsed = projectConfigUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "invalid_project_config" };
  }

  return { ok: true, value: parsed.data };
}

export async function readStoredProjectConfig(
  env: Env,
  projectId: string,
): Promise<StoredProjectConfig | null> {
  const db = shardDb(env, 0);
  await ensureProjectConfigColumns(db);

  const row = await db.prepare(projectConfigSelect).bind(projectId).first<ProjectConfigRow>();
  return row === null ? null : mapProjectConfigRow(row);
}

export async function ensureProjectConfigStorage(env: Env): Promise<void> {
  await ensureProjectConfigColumns(shardDb(env, 0));
}

export async function writeStoredProjectConfig(
  env: Env,
  projectId: string,
  update: ProjectConfigUpdate,
): Promise<
  | { status: "saved"; config: StoredProjectConfig }
  | { status: "not_found" }
  | { status: "version_conflict" }
> {
  const db = shardDb(env, 0);
  await ensureProjectConfigColumns(db);

  const current = await readStoredProjectConfig(env, projectId);
  if (current === null) {
    return { status: "not_found" };
  }

  const result = await db
    .prepare(
      `UPDATE projects
        SET sample_rate = ?,
          retention_days = ?,
          allowed_origins = ?,
          mask_policy_version = ?,
          mask_rules = ?,
          capture_toggles = ?,
          config_version = config_version + 1
        WHERE id = ? AND config_version = ?`,
    )
    .bind(
      update.sampleRate,
      update.retentionDays,
      JSON.stringify(update.allowedOrigins),
      update.maskPolicyVersion,
      JSON.stringify(update.maskRules),
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
  if (stored === null) {
    throw new Error("project config was not readable after update");
  }

  await writeConfigCacheForProject(env, stored);
  return { status: "saved", config: stored };
}

async function ensureProjectConfigColumns(db: D1Database): Promise<void> {
  if (projectConfigColumnsEnsured) {
    return;
  }
  projectConfigColumnsPending ??= (async () => {
    for (const statement of projectConfigColumns) {
      try {
        await db.prepare(statement).run();
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error;
        }
      }
    }
    projectConfigColumnsEnsured = true;
  })();
  try {
    await projectConfigColumnsPending;
  } catch (error) {
    projectConfigColumnsPending = undefined;
    throw error;
  }
}

async function writeConfigCacheForProject(env: Env, config: StoredProjectConfig): Promise<void> {
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
    const wasActive = row.active === 1;
    if (wasActive) {
      await refreshActiveKeyCache(env, database, row.key_hash, config, false);
    } else {
      await syncRevokedKeyCache(env, database, row.key_hash);
    }
  }
}

export async function repairActiveProjectKeyCache(env: Env, now = Date.now()): Promise<number> {
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

    // Mark pending again after the KV write. This prevents another cache writer
    // from leaving a successful marker behind when this write used older data.
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

async function writeKeyConfig(
  env: Env,
  keyHash: string,
  config: StoredProjectConfig,
): Promise<void> {
  const cachedConfig: ProjectConfig = { ...config, active: true };
  await env.CONFIG.put(configKvKey(keyHash), JSON.stringify(cachedConfig));
}

function mapProjectConfigRow(row: ProjectConfigRow): StoredProjectConfig | null {
  const allowedOrigins = parseStringArray(row.allowedOrigins);
  const maskRules = parseMaskRules(row.maskRules);
  const capture = parseCapture(row.capture);
  const jurisdiction = nullableJurisdiction(row.jurisdiction);
  if (allowedOrigins === null || maskRules === null || capture === null || jurisdiction === null) {
    return null;
  }

  const candidate = {
    projectId: row.projectId,
    orgId: row.orgId,
    shard: row.shard,
    active: readActive(row.activeKeyCount),
    sampleRate: row.sampleRate,
    allowedOrigins,
    maskPolicyVersion: row.maskPolicyVersion,
    maskRules,
    capture,
    quotaState: row.quotaState,
    retentionDays: row.retentionDays,
    version: row.version,
    ...(jurisdiction === undefined ? {} : { jurisdiction }),
  };

  const parsed = storedProjectConfigSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function parseStringArray(value: unknown): string[] | null {
  if (typeof value !== "string") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    return null;
  }

  return parsed;
}

function parseMaskRules(value: unknown): MaskRule[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value !== "string") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  const result = maskRulesSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function parseCapture(value: unknown): CaptureToggles | null {
  if (value === undefined || value === null) {
    return { ...defaultCapture };
  }
  if (typeof value !== "string") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  const result = captureTogglesSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function nullableJurisdiction(value: unknown): "eu" | "fedramp" | undefined | null {
  if (value === null || value === undefined) {
    return undefined;
  }

  return value === "eu" || value === "fedramp" ? value : null;
}

function readActive(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("duplicate column");
}
