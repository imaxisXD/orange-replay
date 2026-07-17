-- Charge accepted replay storage before finalization. The per-session row is
-- monotonic so duplicate append and queue retries only add the missing delta.
CREATE TABLE accepted_usage_sessions (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  month TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id)
);

CREATE INDEX idx_accepted_usage_sessions_org_month
  ON accepted_usage_sessions(org_id, month);
