INSERT INTO orange_replay_analytics_sessions_duration_v2_sink
SELECT
  schema_version,
  record_kind,
  export_id,
  export_sequence,
  project_id,
  session_id,
  recorded_at,
  org_id,
  started_at,
  ended_at,
  duration_ms,
  country,
  region,
  city,
  device,
  browser,
  os,
  entry_url,
  url_count,
  page_count,
  analytics_version,
  max_scroll_depth,
  quick_backs,
  interaction_time_ms,
  activity_hist,
  clicks,
  errors,
  rages,
  navs,
  bytes,
  segment_count,
  flags,
  manifest_key,
  analytics_sidecar_key,
  expires_at,
  event_coverage,
  event_count
FROM orange_replay_analytics_stream
WHERE record_kind = 'session'
  AND event_coverage IN ('sparse', 'complete')
  AND org_id IS NOT NULL
  AND started_at IS NOT NULL
  AND ended_at IS NOT NULL
  AND duration_ms IS NOT NULL
  AND url_count IS NOT NULL
  AND analytics_version IS NOT NULL
  AND clicks IS NOT NULL
  AND event_count IS NOT NULL
  AND errors IS NOT NULL
  AND rages IS NOT NULL
  AND navs IS NOT NULL
  AND bytes IS NOT NULL
  AND segment_count IS NOT NULL
  AND flags IS NOT NULL
  AND manifest_key IS NOT NULL
  AND expires_at IS NOT NULL
  AND (event_coverage <> 'complete' OR analytics_sidecar_key IS NOT NULL);

INSERT INTO orange_replay_analytics_events_duration_v2_sink
SELECT
  schema_version,
  record_kind,
  export_id,
  export_sequence,
  project_id,
  session_id,
  recorded_at,
  event_index,
  event_time,
  event_kind,
  event_detail,
  event_meta_json
FROM orange_replay_analytics_stream
WHERE record_kind = 'event'
  AND event_coverage IN ('sparse', 'complete')
  AND event_index IS NOT NULL
  AND event_time IS NOT NULL
  AND event_kind IS NOT NULL;

INSERT INTO orange_replay_analytics_deletions_duration_v2_sink
SELECT
  schema_version,
  record_kind,
  export_id,
  export_sequence,
  project_id,
  session_id,
  recorded_at,
  deleted_at,
  delete_reason
FROM orange_replay_analytics_stream
WHERE record_kind = 'deletion'
  AND event_coverage = 'none'
  AND deleted_at IS NOT NULL
  AND delete_reason IS NOT NULL;
