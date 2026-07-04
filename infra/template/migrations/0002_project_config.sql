-- T3.2: project-config columns (mask rules, capture toggles, config versioning).
-- One statement per line (D1 exec splits on newlines).
ALTER TABLE projects ADD COLUMN mask_rules TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN capture_toggles TEXT NOT NULL DEFAULT '{"heatmaps":false,"console":false,"network":false,"canvas":false}';
ALTER TABLE projects ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;
