ALTER TABLE projects
ADD COLUMN replay_assets_enabled INTEGER NOT NULL DEFAULT 1
CHECK (replay_assets_enabled IN (0, 1));
