import {
  PROJECT_CONFIG_CACHE_TTL_SECONDS,
  configKvKey,
  type ProjectConfig,
} from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
import { ensureProjectConfigStorage } from "../project-config/storage.ts";
import {
  mapConfigRowToProjectConfig,
  parseProjectConfig,
  type ProjectConfigRow,
} from "./project-config-codec.ts";
import { ingestIpRateLimitAllows } from "./rate-limit.ts";

const CONFIG_READ_QUERY =
  "SELECT k.project_id AS projectId, k.active AS active, p.org_id AS orgId, p.retention_days AS retentionDays, p.jurisdiction AS jurisdiction, p.sample_rate AS sampleRate, p.allowed_origins AS allowedOrigins, p.mask_policy_version AS maskPolicyVersion, p.mask_rules AS maskRules, p.capture_toggles AS capture, p.quota_state AS quotaState, p.config_version AS version, o.shard AS shard FROM keys k JOIN projects p ON p.id = k.project_id JOIN orgs o ON o.id = p.org_id WHERE k.key_hash = ?";

export interface ProjectConfigLookupResult {
  config: ProjectConfig | null;
  kvHit: boolean;
  lookupRateLimited: boolean;
}

/**
 * The ingest read interface is deliberately read-only: KV first, then a
 * rate-limited D1 lookup. A D1 result is never written back to KV because an
 * older request could otherwise restore a revoked key or stale configuration.
 */
export async function lookupProjectConfig(
  env: Env,
  keyHash: string,
  request: Request,
  requireRecorderFields = false,
): Promise<ProjectConfigLookupResult> {
  const kvConfig = parseProjectConfig(await getCachedProjectConfig(env, keyHash));
  if (kvConfig !== null && (!requireRecorderFields || hasRecorderFields(kvConfig))) {
    return { config: kvConfig, kvHit: true, lookupRateLimited: false };
  }

  if (!(await ingestIpRateLimitAllows(env, env.INGEST_LOOKUP_RATE_LIMITER, request, "lookup"))) {
    return { config: null, kvHit: false, lookupRateLimited: true };
  }

  await ensureProjectConfigStorage(env);
  const row = await shardDb(env, 0)
    .prepare(CONFIG_READ_QUERY)
    .bind(keyHash)
    .first<ProjectConfigRow>();
  const d1Config = mapConfigRowToProjectConfig(row ?? null);

  return { config: d1Config, kvHit: false, lookupRateLimited: false };
}

function hasRecorderFields(config: ProjectConfig): boolean {
  return (
    config.maskRules !== undefined && config.capture !== undefined && config.version !== undefined
  );
}

async function getCachedProjectConfig(env: Env, keyHash: string): Promise<unknown> {
  try {
    return await env.CONFIG.get(configKvKey(keyHash), {
      type: "json",
      cacheTtl: PROJECT_CONFIG_CACHE_TTL_SECONDS,
    });
  } catch {
    return null;
  }
}
