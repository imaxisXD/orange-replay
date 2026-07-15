-- Save the session date for a separate versioned deletion stream. The
-- existing v1 stream and table remain unchanged during this migration.
ALTER TABLE analytics_deletion_jobs ADD COLUMN session_started_at INTEGER;
