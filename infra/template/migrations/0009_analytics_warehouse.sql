-- Migration 0009 adds the durable outbox and verified R2 analytics cutover state.
CREATE TABLE analytics_export_outbox (
  export_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  export_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('session', 'event', 'deletion')),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json)
    AND length(CAST(payload_json AS BLOB)) <= 32768
  ),
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  quarantined_at INTEGER,
  quarantine_reason TEXT,
  sidecar_event_offset INTEGER NOT NULL DEFAULT 0 CHECK (sidecar_event_offset >= 0)
);

CREATE INDEX idx_analytics_export_outbox_pending
ON analytics_export_outbox(export_sequence)
WHERE sent_at IS NULL AND quarantined_at IS NULL;

CREATE INDEX idx_analytics_export_outbox_project_sequence
ON analytics_export_outbox(project_id, export_sequence);

CREATE INDEX idx_analytics_export_outbox_session_sequence
ON analytics_export_outbox(project_id, session_id, record_kind, export_sequence);

-- Keeps only the small identity needed by versioned D1 comparisons after the
-- full export payload has been proved visible and held for a safety window.
CREATE TABLE analytics_export_ledger (
  export_id TEXT PRIMARY KEY,
  export_sequence INTEGER NOT NULL UNIQUE CHECK (export_sequence > 0),
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('session', 'event', 'deletion')),
  sent_at INTEGER NOT NULL,
  first_seen_verified_at INTEGER NOT NULL
);

CREATE INDEX idx_analytics_export_ledger_session_sequence
ON analytics_export_ledger(project_id, session_id, record_kind, export_sequence);

CREATE TABLE analytics_warehouse_state (
  project_id TEXT PRIMARY KEY,
  verified_sequence INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT
);

-- Queue deliveries and cron repair can overlap. This short renewable lease
-- keeps one analytics sender active for the shard while a stopped Worker can
-- still recover automatically after expiry.
CREATE TABLE analytics_export_lease (
  shard INTEGER PRIMARY KEY CHECK (shard = 0),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  acquired_at INTEGER NOT NULL CHECK (acquired_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at),
  send_available_at INTEGER NOT NULL DEFAULT 0 CHECK (send_available_at >= 0)
);

-- This job survives deletion of the D1 session row and replay objects. The
-- external Iceberg maintenance runner keeps retrying until both warehouse
-- tables are empty twice after Pipeline's late-write window.
CREATE TABLE analytics_deletion_jobs (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL CHECK (requested_at > 0),
  delete_reason TEXT NOT NULL CHECK (length(delete_reason) BETWEEN 1 AND 200),
  requires_warehouse_tombstone INTEGER NOT NULL DEFAULT 1
    CHECK (requires_warehouse_tombstone IN (0, 1)),
  deletion_export_sequence INTEGER CHECK (deletion_export_sequence > 0),
  purge_attempts INTEGER NOT NULL DEFAULT 0 CHECK (purge_attempts >= 0),
  purge_last_attempt_at INTEGER,
  purge_last_error TEXT,
  first_zero_at INTEGER,
  completed_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  alerted_at INTEGER,
  PRIMARY KEY (project_id, session_id)
);

CREATE INDEX idx_analytics_deletion_jobs_pending
ON analytics_deletion_jobs(requested_at, project_id, session_id)
WHERE completed_at IS NULL;

-- This receipt is separate from the delivery watermark on purpose. A positive
-- verified sequence only proves that some rows reached R2. It does not prove
-- that every historical source page was scanned and checked.
CREATE TABLE analytics_backfill_completions (
  project_id TEXT PRIMARY KEY,
  source_session_count INTEGER NOT NULL CHECK (source_session_count >= 0),
  source_cutoff_ms INTEGER NOT NULL CHECK (source_cutoff_ms > 0),
  required_sequence INTEGER NOT NULL CHECK (required_sequence >= 0),
  report_id TEXT NOT NULL CHECK (length(report_id) BETWEEN 1 AND 200),
  completed_at INTEGER NOT NULL CHECK (completed_at > 0)
);
