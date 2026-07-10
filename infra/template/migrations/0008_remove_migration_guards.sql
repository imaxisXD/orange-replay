-- The pre-0005 safety wrapper creates temporary guards that keep ambiguous
-- session ownership stable between its check and Wrangler's migration apply.
-- 0005 normally drops the guarded old tables and their triggers. These
-- statements also clean up a stopped or manually resumed repair.
DROP TRIGGER IF EXISTS orange_replay_0005_guard_event_update;
DROP TRIGGER IF EXISTS orange_replay_0005_guard_event_insert;
DROP TRIGGER IF EXISTS orange_replay_0005_guard_session_update;
DROP TRIGGER IF EXISTS orange_replay_0005_guard_session_insert;
DROP TABLE IF EXISTS _orange_replay_0005_ambiguous_ids;
