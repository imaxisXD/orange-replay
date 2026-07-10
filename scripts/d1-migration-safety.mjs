export const projectScopeRepairMigration = "0005_repair_project_scoped_schema.sql";
export const projectScopeGuardTable = "_orange_replay_0005_ambiguous_ids";
export const projectScopeGuardTriggerPrefix = "orange_replay_0005_guard_";

export const migrationsTableExistsSql = `
SELECT COUNT(*) AS value
FROM sqlite_schema
WHERE type = 'table' AND name = 'd1_migrations'
`;

export const sessionsTableExistsSql = `
SELECT COUNT(*) AS value
FROM sqlite_schema
WHERE type = 'table' AND name = 'sessions'
`;

export const sessionEventsTableExistsSql = `
SELECT COUNT(*) AS value
FROM sqlite_schema
WHERE type = 'table' AND name = 'session_events'
`;

export const projectScopeRepairAppliedSql = `
SELECT COUNT(*) AS value
FROM d1_migrations
WHERE name = '${projectScopeRepairMigration}'
`;

export const installProjectScopeRepairGuardsSql = `
CREATE TABLE IF NOT EXISTS ${projectScopeGuardTable} (
  session_id TEXT PRIMARY KEY
);

CREATE TRIGGER IF NOT EXISTS ${projectScopeGuardTriggerPrefix}session_insert
BEFORE INSERT ON sessions
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions
  WHERE project_id = NEW.project_id AND session_id = NEW.session_id
)
AND EXISTS (
  SELECT 1
  FROM sessions
  WHERE session_id = NEW.session_id AND project_id <> NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'cross-project session id blocked during migration repair');
END;

CREATE TRIGGER IF NOT EXISTS ${projectScopeGuardTriggerPrefix}session_update
BEFORE UPDATE OF session_id, project_id ON sessions
WHEN NEW.session_id <> OLD.session_id OR NEW.project_id <> OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'session identity change blocked during migration repair');
END;

DELETE FROM ${projectScopeGuardTable};
INSERT INTO ${projectScopeGuardTable} (session_id)
SELECT session_id
FROM sessions
GROUP BY session_id
HAVING COUNT(DISTINCT project_id) > 1;

CREATE TRIGGER IF NOT EXISTS ${projectScopeGuardTriggerPrefix}event_insert
BEFORE INSERT ON session_events
WHEN NEW.session_id IN (SELECT session_id FROM ${projectScopeGuardTable})
BEGIN
  SELECT RAISE(ABORT, 'ambiguous session event blocked during migration repair');
END;

CREATE TRIGGER IF NOT EXISTS ${projectScopeGuardTriggerPrefix}event_update
BEFORE UPDATE ON session_events
WHEN NEW.session_id IN (SELECT session_id FROM ${projectScopeGuardTable})
BEGIN
  SELECT RAISE(ABORT, 'ambiguous session event update blocked during migration repair');
END;
`;

export const unsafeSessionEventIdCountSql = `
SELECT COUNT(*) AS value
FROM ${projectScopeGuardTable}
WHERE EXISTS (
  SELECT 1
  FROM session_events
  WHERE session_events.session_id = ${projectScopeGuardTable}.session_id
)
`;
