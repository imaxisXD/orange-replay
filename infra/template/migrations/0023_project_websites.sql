ALTER TABLE projects ADD COLUMN session_cookie_domain TEXT;

CREATE TABLE project_websites (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  allowed_origins TEXT NOT NULL,
  first_event_at INTEGER,
  recorder_key_id TEXT,
  recorder_secret_ciphertext TEXT,
  recorder_secret_iv TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_project_websites_origin
  ON project_websites(project_id, origin);
CREATE INDEX idx_project_websites_project_created
  ON project_websites(project_id, created_at, id);

ALTER TABLE keys ADD COLUMN website_id TEXT;
CREATE INDEX idx_keys_website_active ON keys(website_id, active);
CREATE UNIQUE INDEX idx_keys_one_active_website_key
  ON keys(website_id)
  WHERE website_id IS NOT NULL AND active = 1;
