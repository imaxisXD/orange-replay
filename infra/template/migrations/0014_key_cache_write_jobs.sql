-- Keep in-flight KV writers visible until they finish their D1/KV reconciliation.
CREATE TABLE key_cache_writes (
  id TEXT PRIMARY KEY NOT NULL,
  key_hash TEXT NOT NULL REFERENCES keys(key_hash) ON DELETE CASCADE,
  started_at INTEGER NOT NULL
);
CREATE INDEX idx_key_cache_writes_hash ON key_cache_writes(key_hash);

-- Existing local databases may already have applied 0013. Check every active
-- and revoked key once after this stronger writer tracking is available.
UPDATE keys SET cache_synced = 0, cache_final_check_at = 0;

PRAGMA optimize;
