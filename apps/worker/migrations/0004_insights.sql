ALTER TABLE sessions ADD COLUMN max_scroll_depth INTEGER;
ALTER TABLE sessions ADD COLUMN quick_backs INTEGER;
ALTER TABLE sessions ADD COLUMN interaction_time_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_sessions_project_rages_time ON sessions(project_id, rages, started_at DESC, session_id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project_quick_backs_time ON sessions(project_id, quick_backs, started_at DESC, session_id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project_analytics_version_time ON sessions(project_id, analytics_version, started_at DESC, session_id DESC);
