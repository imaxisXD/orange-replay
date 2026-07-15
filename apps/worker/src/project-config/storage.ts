import {
  captureTogglesSchema,
  maskRulesSchema,
  storedProjectConfigSchema,
} from "@orange-replay/shared";
import type { CaptureToggles, MaskRule, StoredProjectConfig } from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";

const defaultCapture: CaptureToggles = {
  heatmaps: false,
  console: false,
  network: false,
  canvas: false,
};

// Keep this compatibility path until every supported self-host upgrade is
// proven to apply the checked-in D1 migrations before serving requests.
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

export async function readStoredProjectConfig(
  env: Env,
  projectId: string,
): Promise<StoredProjectConfig | null> {
  const database = shardDb(env, 0);
  await ensureProjectConfigColumns(database);

  const row = await database.prepare(projectConfigSelect).bind(projectId).first<ProjectConfigRow>();
  return row === null ? null : mapProjectConfigRow(row);
}

export async function ensureProjectConfigStorage(env: Env): Promise<void> {
  await ensureProjectConfigColumns(shardDb(env, 0));
}

async function ensureProjectConfigColumns(database: D1Database): Promise<void> {
  if (projectConfigColumnsEnsured) return;

  projectConfigColumnsPending ??= (async () => {
    for (const statement of projectConfigColumns) {
      try {
        await database.prepare(statement).run();
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
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
  if (typeof value !== "string") return null;

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
  if (value === undefined || value === null) return [];
  if (typeof value !== "string") return null;

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
  if (value === undefined || value === null) return { ...defaultCapture };
  if (typeof value !== "string") return null;

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
  if (value === null || value === undefined) return undefined;
  return value === "eu" || value === "fedramp" ? value : null;
}

function readActive(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("duplicate column");
}
