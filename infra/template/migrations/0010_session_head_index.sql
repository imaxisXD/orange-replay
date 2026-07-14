ALTER TABLE sessions ADD COLUMN indexed_at INTEGER NOT NULL DEFAULT 0;

UPDATE sessions
SET indexed_at = ended_at
WHERE indexed_at = 0;

DROP INDEX IF EXISTS idx_sessions_project_time;

CREATE INDEX idx_sessions_project_time
  ON sessions(project_id, started_at DESC, session_id DESC);

CREATE INDEX idx_sessions_project_indexed_at
  ON sessions(project_id, indexed_at DESC, session_id DESC);

CREATE INDEX idx_analytics_export_outbox_project_kind_sequence
  ON analytics_export_outbox(project_id, record_kind, export_sequence DESC);

CREATE INDEX idx_analytics_export_ledger_project_kind_sequence
  ON analytics_export_ledger(project_id, record_kind, export_sequence DESC);
