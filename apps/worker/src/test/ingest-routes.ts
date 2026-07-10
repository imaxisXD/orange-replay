import { configKvKey, projectConfigSchema } from "@orange-replay/shared";
import type { ProjectConfig } from "@orange-replay/shared";
import { shardDb } from "../env.ts";
import type { Env } from "../env.ts";
import { sha256Hex } from "../ingest/helpers.ts";

const CONTROL_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, shard INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, jurisdiction TEXT, retention_days INTEGER NOT NULL DEFAULT 30, sample_rate REAL NOT NULL DEFAULT 1.0, allowed_origins TEXT NOT NULL, mask_policy_version INTEGER NOT NULL DEFAULT 1, mask_rules TEXT NOT NULL DEFAULT '[]', capture_toggles TEXT NOT NULL DEFAULT '{"heatmaps":false,"console":false,"network":false,"canvas":false}', quota_state TEXT NOT NULL DEFAULT 'ok', config_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS keys (key_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (session_id TEXT NOT NULL, project_id TEXT NOT NULL, org_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, country TEXT, region TEXT, city TEXT, device TEXT, browser TEXT, os TEXT, entry_url TEXT, url_count INTEGER NOT NULL DEFAULT 0, page_count INTEGER, analytics_version INTEGER NOT NULL DEFAULT 0, max_scroll_depth INTEGER, quick_backs INTEGER, interaction_time_ms INTEGER, activity_hist TEXT, clicks INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rages INTEGER NOT NULL DEFAULT 0, navs INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, segment_count INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0, manifest_key TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (project_id, session_id))`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_time ON sessions(project_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_country_time ON sessions(project_id, country, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_region_time ON sessions(project_id, region, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_device_time ON sessions(project_id, device, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_browser_time ON sessions(project_id, browser, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_os_time ON sessions(project_id, os, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_entry_url_time ON sessions(project_id, entry_url, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_errors_time ON sessions(project_id, errors, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_duration_time ON sessions(project_id, duration_ms, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_rages_time ON sessions(project_id, rages, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_quick_backs_time ON sessions(project_id, quick_backs, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_analytics_version_time ON sessions(project_id, analytics_version, started_at DESC, session_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS session_events (project_id TEXT NOT NULL, session_id TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT, PRIMARY KEY (project_id, session_id, t, kind))`,
  `CREATE TABLE IF NOT EXISTS session_deletions (project_id TEXT NOT NULL, session_id TEXT NOT NULL, requested_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY (project_id, session_id))`,
  `CREATE TABLE IF NOT EXISTS usage_monthly (org_id TEXT NOT NULL, month TEXT NOT NULL, sessions INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, month))`,
] as const;

interface SeedRequest {
  key: unknown;
  config: unknown;
  kv?: unknown;
}

export function handleIngestTestRoutes(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/__test/ingest/seed" && request.method === "POST") {
    return seedIngestControlPlane(request, env);
  }
  if (url.pathname === "/__test/ingest/config-cache" && request.method === "GET") {
    return readConfigCache(url, env);
  }

  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
}

async function readConfigCache(url: URL, env: Env): Promise<Response> {
  const keyHash = url.searchParams.get("keyHash");
  if (keyHash === null || keyHash.length === 0) {
    return Response.json({ error: "keyHash is required" }, { status: 400 });
  }

  const config = await env.CONFIG.get(configKvKey(keyHash), { type: "json" });
  return Response.json({ config });
}

async function seedIngestControlPlane(request: Request, env: Env): Promise<Response> {
  let body: SeedRequest;
  try {
    body = (await request.json()) as SeedRequest;
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }

  if (typeof body.key !== "string" || body.key.length === 0) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }

  const parsedConfig = projectConfigSchema.safeParse(body.config);
  if (!parsedConfig.success) {
    return Response.json({ error: "config is not valid" }, { status: 400 });
  }

  const config = parsedConfig.data;
  const keyHash = await sha256Hex(body.key);
  await createControlTables(env);
  await putRows(env, keyHash, config);

  if (body.kv === true) {
    await env.CONFIG.put(configKvKey(keyHash), JSON.stringify(config));
  }

  return Response.json({ keyHash });
}

async function createControlTables(env: Env): Promise<void> {
  const db = shardDb(env, 0);
  for (const statement of CONTROL_TABLE_DDL) {
    await db.prepare(statement).run();
  }
}

async function putRows(env: Env, keyHash: string, config: ProjectConfig): Promise<void> {
  const db = shardDb(env, 0);
  const now = Date.now();

  await db
    .prepare(`INSERT OR REPLACE INTO orgs (id, name, shard, created_at) VALUES (?, ?, ?, ?)`)
    .bind(config.orgId, config.orgId, config.shard, now)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO projects (id, org_id, name, jurisdiction, retention_days, sample_rate, allowed_origins, mask_policy_version, mask_rules, capture_toggles, quota_state, config_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      config.projectId,
      config.orgId,
      config.projectId,
      config.jurisdiction ?? null,
      config.retentionDays,
      config.sampleRate,
      JSON.stringify(config.allowedOrigins),
      config.maskPolicyVersion,
      JSON.stringify(config.maskRules ?? []),
      JSON.stringify(
        config.capture ?? {
          heatmaps: false,
          console: false,
          network: false,
          canvas: false,
        },
      ),
      config.quotaState,
      config.version ?? 1,
      now,
    )
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO keys (key_hash, project_id, active, created_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(keyHash, config.projectId, config.active ? 1 : 0, now)
    .run();
}
