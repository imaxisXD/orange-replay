-- Private, retention-bound replay assets. Source URLs stay out of D1; the
-- authenticated per-session R2 map is deleted with the recording prefix.
CREATE TABLE replay_asset_objects (
  asset_hash TEXT PRIMARY KEY NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE replay_project_assets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asset_hash TEXT NOT NULL REFERENCES replay_asset_objects(asset_hash) ON DELETE CASCADE,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, asset_hash)
);

-- A short-lived URL lookup lets later sessions reuse bytes without pinning a
-- same-URL deployment forever. Original URL strings remain only in the
-- private, retention-bound R2 session map.
CREATE TABLE replay_asset_urls (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_url_hash TEXT NOT NULL,
  asset_hash TEXT NOT NULL REFERENCES replay_asset_objects(asset_hash) ON DELETE CASCADE,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, source_url_hash)
);

CREATE TABLE replay_session_assets (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_hash TEXT NOT NULL DEFAULT '',
  source_url_hash TEXT NOT NULL,
  asset_hash TEXT NOT NULL REFERENCES replay_asset_objects(asset_hash) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('stylesheet', 'image', 'font')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id, parent_hash, source_url_hash),
  FOREIGN KEY (project_id, session_id)
    REFERENCES sessions(project_id, session_id) ON DELETE CASCADE
);

CREATE INDEX idx_replay_session_assets_hash
ON replay_session_assets(project_id, session_id, asset_hash);

CREATE INDEX idx_replay_session_assets_expiry
ON replay_session_assets(expires_at, project_id, session_id);

CREATE TABLE replay_asset_fetch_budgets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  fetches INTEGER NOT NULL DEFAULT 0 CHECK (fetches >= 0),
  PRIMARY KEY (project_id, day)
);

CREATE TABLE replay_asset_attempts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_url_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (project_id, source_url_hash, day)
);
