-- Migration 0013 gives every revoked key a durable final KV deletion after writers finish.
ALTER TABLE keys ADD COLUMN cache_final_check_at INTEGER;
UPDATE keys SET cache_synced = 0, cache_final_check_at = 0;
CREATE INDEX idx_keys_cache_final_check ON keys(active, cache_final_check_at);

PRAGMA optimize;
