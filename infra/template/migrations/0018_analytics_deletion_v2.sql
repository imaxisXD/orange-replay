-- Backfill every retained warehouse tombstone into a separate, versioned
-- deletion table before any runtime read can use its date column.
ALTER TABLE analytics_deletion_jobs ADD COLUMN deletion_v2_sent_at INTEGER;
ALTER TABLE analytics_deletion_jobs ADD COLUMN deletion_v2_visible_at INTEGER;
ALTER TABLE analytics_deletion_jobs
ADD COLUMN deletion_v2_attempt_count INTEGER NOT NULL DEFAULT 0
CHECK (deletion_v2_attempt_count >= 0);
ALTER TABLE analytics_deletion_jobs ADD COLUMN deletion_v2_last_error TEXT;

-- Recover the date while a retained session row or its full outbox payload
-- still exists. Older physically deleted sessions stay NULL and are always
-- included by the v2 compatibility query.
UPDATE analytics_deletion_jobs
SET session_started_at = COALESCE(
  (
    SELECT s.started_at
    FROM sessions s
    WHERE s.project_id = analytics_deletion_jobs.project_id
      AND s.session_id = analytics_deletion_jobs.session_id
  ),
  (
    SELECT CAST(json_extract(o.payload_json, '$.started_at') AS INTEGER)
    FROM analytics_export_outbox o
    WHERE o.project_id = analytics_deletion_jobs.project_id
      AND o.session_id = analytics_deletion_jobs.session_id
      AND o.record_kind = 'session'
      AND json_type(o.payload_json, '$.started_at') = 'integer'
    ORDER BY o.export_sequence DESC
    LIMIT 1
  )
)
WHERE session_started_at IS NULL;

CREATE INDEX idx_analytics_deletion_jobs_v2_pending
ON analytics_deletion_jobs(
  deletion_v2_visible_at,
  deletion_v2_sent_at,
  deletion_v2_attempt_count,
  requested_at,
  project_id,
  session_id
)
WHERE requires_warehouse_tombstone = 1;

-- A missing row means the v2 table has never been proved queryable. Counts
-- are refreshed after each maintenance pass; runtime also checks the jobs
-- directly so a newly inserted tombstone immediately sends reads back to v1.
CREATE TABLE analytics_deletion_v2_state (
  shard INTEGER PRIMARY KEY CHECK (shard = 0),
  required_job_count INTEGER NOT NULL DEFAULT 0 CHECK (required_job_count >= 0),
  visible_job_count INTEGER NOT NULL DEFAULT 0 CHECK (visible_job_count >= 0),
  last_attempt_at INTEGER,
  last_error TEXT,
  backfill_completed_at INTEGER,
  CHECK (visible_job_count <= required_job_count)
);
