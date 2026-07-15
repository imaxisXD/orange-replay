-- Exact shared budget for costly R2 SQL reads. Unlike the edge rate-limit
-- binding, this D1 row is shared across Cloudflare locations.
CREATE TABLE analytics_read_budget (
  scope TEXT PRIMARY KEY CHECK (scope = 'warehouse_global'),
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 600)
);
