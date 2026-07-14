const TEST_DATABASE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, shard INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, jurisdiction TEXT, retention_days INTEGER NOT NULL DEFAULT 30, sample_rate REAL NOT NULL DEFAULT 1.0, allowed_origins TEXT NOT NULL, mask_policy_version INTEGER NOT NULL DEFAULT 1, mask_rules TEXT NOT NULL DEFAULT \'[]\', capture_toggles TEXT NOT NULL DEFAULT \'{"heatmaps":false,"console":false,"network":false,"canvas":false}\', quota_state TEXT NOT NULL DEFAULT \'ok\', config_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS keys (key_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (session_id TEXT NOT NULL, project_id TEXT NOT NULL, org_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, country TEXT, region TEXT, city TEXT, device TEXT, browser TEXT, os TEXT, entry_url TEXT, url_count INTEGER NOT NULL DEFAULT 0, page_count INTEGER, analytics_version INTEGER NOT NULL DEFAULT 0, max_scroll_depth INTEGER, quick_backs INTEGER, interaction_time_ms INTEGER, activity_hist TEXT, clicks INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rages INTEGER NOT NULL DEFAULT 0, navs INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, segment_count INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0, manifest_key TEXT NOT NULL, expires_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, session_id))",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_time ON sessions(project_id, started_at DESC, session_id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_project_indexed_at ON sessions(project_id, indexed_at DESC, session_id DESC)",
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
  "CREATE TABLE IF NOT EXISTS analytics_export_outbox (export_sequence INTEGER PRIMARY KEY AUTOINCREMENT, export_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, session_id TEXT NOT NULL, record_kind TEXT NOT NULL CHECK (record_kind IN ('session', 'event', 'deletion')), payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 32768), created_at INTEGER NOT NULL, sent_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, quarantined_at INTEGER, quarantine_reason TEXT, sidecar_event_offset INTEGER NOT NULL DEFAULT 0 CHECK (sidecar_event_offset >= 0))",
  "CREATE INDEX IF NOT EXISTS idx_analytics_export_outbox_pending ON analytics_export_outbox(export_sequence) WHERE sent_at IS NULL AND quarantined_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_analytics_export_outbox_project_sequence ON analytics_export_outbox(project_id, export_sequence)",
  "CREATE INDEX IF NOT EXISTS idx_analytics_export_outbox_project_kind_sequence ON analytics_export_outbox(project_id, record_kind, export_sequence DESC)",
  "CREATE INDEX IF NOT EXISTS idx_analytics_export_outbox_session_sequence ON analytics_export_outbox(project_id, session_id, record_kind, export_sequence)",
  "CREATE TABLE IF NOT EXISTS analytics_export_ledger (export_id TEXT PRIMARY KEY, export_sequence INTEGER NOT NULL UNIQUE CHECK (export_sequence > 0), project_id TEXT NOT NULL, session_id TEXT NOT NULL, record_kind TEXT NOT NULL CHECK (record_kind IN ('session', 'event', 'deletion')), sent_at INTEGER NOT NULL, first_seen_verified_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_analytics_export_ledger_session_sequence ON analytics_export_ledger(project_id, session_id, record_kind, export_sequence)",
  "CREATE INDEX IF NOT EXISTS idx_analytics_export_ledger_project_kind_sequence ON analytics_export_ledger(project_id, record_kind, export_sequence DESC)",
  "CREATE TABLE IF NOT EXISTS analytics_warehouse_state (project_id TEXT PRIMARY KEY, verified_sequence INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, last_attempt_at INTEGER, last_error TEXT)",
  "CREATE TABLE IF NOT EXISTS analytics_export_lease (shard INTEGER PRIMARY KEY CHECK (shard = 0), owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200), acquired_at INTEGER NOT NULL CHECK (acquired_at > 0), expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at), send_available_at INTEGER NOT NULL DEFAULT 0 CHECK (send_available_at >= 0))",
  "CREATE TABLE IF NOT EXISTS analytics_deletion_jobs (project_id TEXT NOT NULL, session_id TEXT NOT NULL, requested_at INTEGER NOT NULL CHECK (requested_at > 0), delete_reason TEXT NOT NULL CHECK (length(delete_reason) BETWEEN 1 AND 200), requires_warehouse_tombstone INTEGER NOT NULL DEFAULT 1 CHECK (requires_warehouse_tombstone IN (0, 1)), deletion_export_sequence INTEGER CHECK (deletion_export_sequence > 0), purge_attempts INTEGER NOT NULL DEFAULT 0 CHECK (purge_attempts >= 0), purge_last_attempt_at INTEGER, purge_last_error TEXT, first_zero_at INTEGER, completed_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, alerted_at INTEGER, PRIMARY KEY (project_id, session_id))",
  "CREATE INDEX IF NOT EXISTS idx_analytics_deletion_jobs_pending ON analytics_deletion_jobs(requested_at, project_id, session_id) WHERE completed_at IS NULL",
  "CREATE TABLE IF NOT EXISTS analytics_backfill_completions (project_id TEXT PRIMARY KEY, source_session_count INTEGER NOT NULL CHECK (source_session_count >= 0), source_cutoff_ms INTEGER NOT NULL CHECK (source_cutoff_ms > 0), required_sequence INTEGER NOT NULL CHECK (required_sequence >= 0), report_id TEXT NOT NULL CHECK (length(report_id) BETWEEN 1 AND 200), completed_at INTEGER NOT NULL CHECK (completed_at > 0))",
] as const;

export async function createTestDatabaseSchema(db: D1Database): Promise<void> {
  for (const statement of TEST_DATABASE_SCHEMA) {
    await db.prepare(statement).run();
  }
}
