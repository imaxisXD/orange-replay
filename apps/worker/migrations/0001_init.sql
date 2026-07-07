-- Orange Replay D1 shard schema, v1.
-- Must stay byte-compatible with the DDL used by the /__test seed routes
-- (src/test/ingest-routes.ts et al.) — integration tests create the same
-- tables; drift between the two is a review-blocking defect.

-- Control plane (hosted: separate control DB later; self-host: same DB).
CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, shard INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, jurisdiction TEXT, retention_days INTEGER NOT NULL DEFAULT 30, sample_rate REAL NOT NULL DEFAULT 1.0, allowed_origins TEXT NOT NULL, mask_policy_version INTEGER NOT NULL DEFAULT 1, quota_state TEXT NOT NULL DEFAULT 'ok', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS keys (key_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);

-- Session index (written only by the queue consumer, in batches).
CREATE TABLE IF NOT EXISTS sessions (session_id TEXT NOT NULL, project_id TEXT NOT NULL, org_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, country TEXT, region TEXT, city TEXT, device TEXT, browser TEXT, os TEXT, entry_url TEXT, url_count INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, rages INTEGER NOT NULL DEFAULT 0, navs INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, segment_count INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0, manifest_key TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (project_id, session_id));
CREATE INDEX IF NOT EXISTS idx_sessions_project_time ON sessions(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- Sparse notable events for "sessions where X happened" filters.
CREATE TABLE IF NOT EXISTS session_events (project_id TEXT NOT NULL, session_id TEXT NOT NULL, t INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT, PRIMARY KEY (project_id, session_id, t, kind));
CREATE TABLE IF NOT EXISTS session_deletions (project_id TEXT NOT NULL, session_id TEXT NOT NULL, requested_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY (project_id, session_id));

-- Exact metering (billing/limits source of truth; Analytics Engine is trends only).
CREATE TABLE IF NOT EXISTS usage_monthly (org_id TEXT NOT NULL, month TEXT NOT NULL, sessions INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, month));
