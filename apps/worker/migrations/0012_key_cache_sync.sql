-- Migration 0012 keeps failed key-cache invalidations durable for scheduled repair.
ALTER TABLE keys ADD COLUMN cache_synced INTEGER NOT NULL DEFAULT 1;
UPDATE keys SET cache_synced = 0 WHERE active = 0;
CREATE INDEX idx_keys_cache_sync ON keys(active, cache_synced, revoked_at);

PRAGMA optimize;
