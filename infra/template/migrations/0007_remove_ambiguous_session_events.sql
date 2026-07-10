-- 0005 had to recover project ids from the original globally unique session id.
-- A database created from the short-lived project-scoped 0001 could instead
-- contain the same session id in more than one project. Event ownership for
-- those ids is no longer provable after 0005, so fail closed by removing only
-- their sparse event index rows. Sessions and replay objects are not changed.
DELETE FROM session_events
WHERE NOT EXISTS (
  SELECT 1
  FROM sessions
  WHERE sessions.project_id = session_events.project_id
    AND sessions.session_id = session_events.session_id
)
OR session_id IN (
  SELECT sessions.session_id
  FROM sessions
  GROUP BY sessions.session_id
  HAVING COUNT(DISTINCT sessions.project_id) > 1
);
