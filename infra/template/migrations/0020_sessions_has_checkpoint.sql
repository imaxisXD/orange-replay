-- Playability fact for finalized sessions: 1 when any segment carries a
-- full-snapshot checkpoint, 0 when none does (nothing to replay), NULL for
-- rows indexed before this fact existed. Spec: docs/specs/fix-zero-duration-sessions.md
ALTER TABLE sessions ADD COLUMN has_checkpoint INTEGER;
