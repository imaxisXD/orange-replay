-- A recording expiry blocks replay access but keeps its scrubbed analytics.
-- Explicit user and privacy deletions continue to erase both.
ALTER TABLE session_deletions
ADD COLUMN delete_analytics INTEGER NOT NULL DEFAULT 1
CHECK (delete_analytics IN (0, 1));

UPDATE session_deletions
SET delete_analytics = 0
WHERE EXISTS (
  SELECT 1
  FROM analytics_deletion_jobs job
  WHERE job.project_id = session_deletions.project_id
    AND job.session_id = session_deletions.session_id
    AND job.delete_reason = 'retention_expired'
);

-- Old recording-retention jobs were queued as immediate analytics erasures.
-- Reschedule them for two years after the session began and give the future
-- tombstone a new identity when it becomes due.
UPDATE analytics_deletion_jobs
SET requested_at = COALESCE(
    session_started_at + 63072000000,
    requested_at + 63072000000
  ),
  delete_reason = 'analytics_retention_expired',
  deletion_export_sequence = NULL,
  purge_attempts = 0,
  purge_last_attempt_at = NULL,
  purge_last_error = NULL,
  first_zero_at = NULL,
  completed_at = NULL,
  lease_owner = NULL,
  lease_expires_at = NULL,
  alerted_at = NULL,
  deletion_v2_sent_at = NULL,
  deletion_v2_visible_at = NULL,
  deletion_v2_attempt_count = 0,
  deletion_v2_last_error = NULL
WHERE delete_reason = 'retention_expired';

DELETE FROM analytics_deletion_v2_state;
