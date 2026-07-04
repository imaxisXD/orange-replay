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

export async function writeStoredProjectConfig(
  env: Env,
  projectId: string,
  update: ProjectConfigUpdate,
): Promise<StoredProjectConfig | null> {
  const db = shardDb(env, 0);
  await ensureProjectConfigColumns(db);

  const current = await readStoredProjectConfig(env, projectId);
  if (current === null) {
    return null;
  }

  const nextJurisdiction =
    update.jurisdiction === undefined ? (current.jurisdiction ?? null) : update.jurisdiction;

  const result = await db
    .prepare(
      `UPDATE projects
        SET sample_rate = ?,
          allowed_origins = ?,
          mask_policy_version = ?,
          mask_rules = ?,
          capture_toggles = ?,
          quota_state = ?,
          jurisdiction = ?,
          config_version = config_version + 1
        WHERE id = ?`,
    )
    .bind(
      update.sampleRate,
      JSON.stringify(update.allowedOrigins),
      update.maskPolicyVersion,
      JSON.stringify(update.maskRules),
      JSON.stringify(update.capture),
      update.quotaState,
      nextJurisdiction,
      projectId,
    )
    .run();

  if ((result.meta.changes ?? 0) < 1) {
    return null;
  }

  const stored = await readStoredProjectConfig(env, projectId);
  if (stored === null) {
    throw new Error("project config was not readable after update");
  }

  await writeConfigCacheForProject(env, stored);
  return stored;
}

async function ensureProjectConfigColumns(db: D1Database): Promise<void> {
  for (const statement of projectConfigColumns) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      if (!isDuplicateColumnError(error)) {
        throw error;
      }
    }
  }
}

async function writeConfigCacheForProject(env: Env, config: StoredProjectConfig): Promise<void> {
  const rows = await shardDb(env, 0)
    .prepare("SELECT key_hash, active FROM keys WHERE project_id = ?")
    .bind(config.projectId)
    .all<KeyRow>();

  for (const row of rows.results ?? []) {
    const cachedConfig: ProjectConfig = {
      ...config,
      active: row.active === 1,
    };
    await env.CONFIG.put(configKvKey(row.key_hash), JSON.stringify(cachedConfig));
  }
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
