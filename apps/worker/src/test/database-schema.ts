const TEST_DATABASE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, shard INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, jurisdiction TEXT, retention_days INTEGER NOT NULL DEFAULT 30, sample_rate REAL NOT NULL DEFAULT 1.0, allowed_origins TEXT NOT NULL, mask_policy_version INTEGER NOT NULL DEFAULT 1, mask_rules TEXT NOT NULL DEFAULT \'[]\', capture_toggles TEXT NOT NULL DEFAULT \'{"heatmaps":false,"console":false,"network":false,"canvas":false}\', quota_state TEXT NOT NULL DEFAULT \'ok\', config_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS keys (key_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (session_id TEXT NOT NULL, project_id TEXT NOT NULL, org_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, country TEXT, region TEXT, city TEXT, device TEXT, browser TEXT, os TEXT, entry_url TEXT, url_count INTEGER NOT NULL DEFAULT 0, page_count INTEGER, analytics_version INTEGER NOT NULL DEFAULT 0, max_scroll_depth INTEGER, quick_backs INTEGER, interaction_time_ms INTEGER, activity_hist TEXT, clicks INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rages INTEGER NOT NULL DEFAULT 0, navs INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, segment_count INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0, manifest_key TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (project_id, session_id))",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_time ON sessions(project_id, started_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_country_time ON sessions(project_id, country, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_region_time ON sessions(project_id, region, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_device_time ON sessions(project_id, device, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_browser_time ON sessions(project_id, browser, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_os_time ON sessions(project_id, os, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_entry_url_time ON sessions(project_id, entry_url, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_errors_time ON sessions(project_id, errors, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_duration_time ON sessions(project_id, duration_ms, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_rages_time ON sessions(project_id, rages, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_quick_backs_time ON sessions(project_id, quick_backs, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_analytics_version_time ON sessions(project_id, analytics_version, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)",
  "CREATE TABLE IF NOT EXISTS session_events (project_id TEXT NOT NULL, session_id TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT, PRIMARY KEY (project_id, session_id, t, kind))",
  "CREATE TABLE IF NOT EXISTS session_deletions (project_id TEXT NOT NULL, session_id TEXT NOT NULL, requested_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY (project_id, session_id))",
  "CREATE TABLE IF NOT EXISTS usage_monthly (org_id TEXT NOT NULL, month TEXT NOT NULL, sessions INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, month))",
] as const;

export async function createTestDatabaseSchema(db: D1Database): Promise<void> {
  for (const statement of TEST_DATABASE_SCHEMA) {
    await db.prepare(statement).run();
  }
}
