-- City breakdown and city session filters read sessions by (project, city, time),
-- matching the per-dimension index pattern from 0003_analytics_base.
CREATE INDEX IF NOT EXISTS idx_sessions_project_city_time ON sessions(project_id, city, started_at DESC, session_id DESC);
