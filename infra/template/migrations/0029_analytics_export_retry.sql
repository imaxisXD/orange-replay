-- Retain failed exports while allowing unrelated ready work to continue.
ALTER TABLE analytics_export_outbox
ADD COLUMN next_retry_at INTEGER NOT NULL DEFAULT 0;
