INSERT INTO orange_replay_analytics_deletions_v2_sink
SELECT
  schema_version,
  record_kind,
  export_id,
  export_sequence,
  project_id,
  session_id,
  recorded_at,
  deleted_at,
  delete_reason,
  session_started_at
FROM orange_replay_analytics_deletion_v2_stream
WHERE schema_version = 2
  AND record_kind = 'deletion';
