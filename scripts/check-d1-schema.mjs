import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  installProjectScopeRepairGuardsSql,
  projectScopeGuardTable,
  projectScopeGuardTriggerPrefix,
  projectScopeRepairMigration,
  unsafeSessionEventIdCountSql,
} from "./d1-migration-safety.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const migrationsDir = path.join(workerDir, "migrations");

runDrizzle(["check", "--config", "drizzle.config.ts"], "inherit");
const drizzleSql = runDrizzle(["export", "--config", "drizzle.config.ts"], "capture");

const allMigrationNames = migrationNames();
const migratedDatabase = new DatabaseSync(":memory:");
for (const migrationName of allMigrationNames) {
  const migrationPath = path.join(migrationsDir, migrationName);
  try {
    migratedDatabase.exec(readFileSync(migrationPath, "utf8"));
  } catch (error) {
    console.error(`Migration ${migrationName} could not be applied to a fresh database.`);
    throw error;
  }
}

const drizzleDatabase = new DatabaseSync(":memory:");
drizzleDatabase.exec(drizzleSql.replaceAll("--> statement-breakpoint", ""));

const migratedSchema = readSchema(migratedDatabase);
const drizzleSchema = readSchema(drizzleDatabase);
const tableNames = [
  ...new Set([...Object.keys(migratedSchema), ...Object.keys(drizzleSchema)]),
].sort();
let hasDifference = false;

for (const tableName of tableNames) {
  const migratedTable = migratedSchema[tableName];
  const drizzleTable = drizzleSchema[tableName];
  if (JSON.stringify(migratedTable) === JSON.stringify(drizzleTable)) continue;

  hasDifference = true;
  console.error(`D1 schema differs for table ${tableName}.`);
  console.error("From Wrangler migrations:");
  console.error(JSON.stringify(migratedTable ?? null, null, 2));
  console.error("From Drizzle schema:");
  console.error(JSON.stringify(drizzleTable ?? null, null, 2));
}

migratedDatabase.close();
drizzleDatabase.close();

if (hasDifference) {
  console.error("Update apps/worker/src/db/schema.ts or add a new numbered migration.");
  process.exit(1);
}

verifyAmbiguousEventRepair(allMigrationNames);
verifyGuardsDropWithProjectScopeRepair(allMigrationNames);
verifyGuardRecoveryCanUnblock(allMigrationNames);
console.log(`D1 schema matches Drizzle across ${tableNames.length} tables.`);

function verifyAmbiguousEventRepair(names) {
  const repairMigrationName = "0007_remove_ambiguous_session_events.sql";
  const guardCleanupMigrationName = "0008_remove_migration_guards.sql";
  const repairIndex = names.indexOf(repairMigrationName);
  const guardCleanupIndex = names.indexOf(guardCleanupMigrationName);
  assert.notEqual(repairIndex, -1, `${repairMigrationName} is missing.`);
  assert.ok(guardCleanupIndex > repairIndex, `${guardCleanupMigrationName} must run after 0007.`);
  assert.ok(
    names.indexOf(projectScopeRepairMigration) < repairIndex,
    `${repairMigrationName} must run after ${projectScopeRepairMigration}.`,
  );

  const database = new DatabaseSync(":memory:");
  try {
    for (const migrationName of names.slice(0, repairIndex)) {
      database.exec(readFileSync(path.join(migrationsDir, migrationName), "utf8"));
    }

    const insertSession = database.prepare(`
      INSERT INTO sessions (
        session_id, project_id, org_id, started_at, ended_at,
        duration_ms, manifest_key, expires_at
      ) VALUES (?, ?, 'org_test', 1, 2, 1, ?, 100)
    `);
    insertSession.run("shared_session", "project_a", "a/manifest.json");
    insertSession.run("shared_session", "project_b", "b/manifest.json");
    insertSession.run("unique_session", "project_a", "unique/manifest.json");

    const insertEvent = database.prepare(`
      INSERT INTO session_events (project_id, session_id, t, kind, detail)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertEvent.run("project_a", "shared_session", 10, "error", "from a");
    insertEvent.run("project_b", "shared_session", 20, "error", "from b");
    insertEvent.run("project_a", "unique_session", 30, "custom", "keep");
    insertEvent.run("missing_project", "missing_session", 40, "error", "orphan");

    database.exec(installProjectScopeRepairGuardsSql);
    const unsafeBefore = database.prepare(unsafeSessionEventIdCountSql).get();
    assert.equal(Number(unsafeBefore?.value), 1);
    assert.throws(
      () => insertSession.run("unique_session", "project_b", "blocked/manifest.json"),
      /cross-project session id blocked/,
    );
    assert.throws(
      () => insertEvent.run("project_a", "shared_session", 50, "error", "blocked"),
      /ambiguous session event blocked/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            "UPDATE session_events SET detail = 'blocked' WHERE project_id = 'project_a' AND session_id = 'shared_session'",
          )
          .run(),
      /ambiguous session event update blocked/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            "UPDATE sessions SET session_id = 'changed' WHERE project_id = 'project_a' AND session_id = 'unique_session'",
          )
          .run(),
      /session identity change blocked/,
    );

    database.exec(readFileSync(path.join(migrationsDir, repairMigrationName), "utf8"));
    const remainingEvents = database
      .prepare(
        "SELECT project_id, session_id, t, kind, detail FROM session_events ORDER BY project_id, session_id, t",
      )
      .all()
      .map((row) => ({ ...row }));

    assert.deepEqual(remainingEvents, [
      {
        project_id: "project_a",
        session_id: "unique_session",
        t: 30,
        kind: "custom",
        detail: "keep",
      },
    ]);

    database.exec(readFileSync(path.join(migrationsDir, guardCleanupMigrationName), "utf8"));
    assert.equal(countGuardObjects(database), 0);
  } finally {
    database.close();
  }

  console.log("D1 tenant-event repair removes ambiguous and orphaned sparse events.");
}

function verifyGuardsDropWithProjectScopeRepair(names) {
  const repairIndex = names.indexOf(projectScopeRepairMigration);
  assert.notEqual(repairIndex, -1, `${projectScopeRepairMigration} is missing.`);

  const database = new DatabaseSync(":memory:");
  try {
    for (const migrationName of names.slice(0, repairIndex)) {
      database.exec(readFileSync(path.join(migrationsDir, migrationName), "utf8"));
    }

    database.exec(installProjectScopeRepairGuardsSql);
    assert.equal(countGuardObjects(database), 5);
    database.exec(readFileSync(path.join(migrationsDir, projectScopeRepairMigration), "utf8"));
    assert.equal(countGuardObjects(database), 1);
  } finally {
    database.close();
  }

  console.log("D1 preflight guards remain valid until 0005 drops the guarded tables.");
}

function verifyGuardRecoveryCanUnblock(names) {
  const repairIndex = names.indexOf("0007_remove_ambiguous_session_events.sql");
  assert.notEqual(repairIndex, -1, "0007_remove_ambiguous_session_events.sql is missing.");

  const database = new DatabaseSync(":memory:");
  try {
    for (const migrationName of names.slice(0, repairIndex)) {
      database.exec(readFileSync(path.join(migrationsDir, migrationName), "utf8"));
    }

    const insertSession = database.prepare(`
      INSERT INTO sessions (
        session_id, project_id, org_id, started_at, ended_at,
        duration_ms, manifest_key, expires_at
      ) VALUES ('shared_session', ?, 'org_test', 1, 2, 1, ?, 100)
    `);
    insertSession.run("project_a", "a/manifest.json");
    insertSession.run("project_b", "b/manifest.json");
    database.exec(`
      INSERT INTO session_events (project_id, session_id, t, kind, detail)
      VALUES ('project_a', 'shared_session', 10, 'error', 'remove')
    `);

    database.exec(installProjectScopeRepairGuardsSql);
    assert.equal(Number(database.prepare(unsafeSessionEventIdCountSql).get()?.value), 1);
    database.exec(`
      DELETE FROM session_events
      WHERE session_id IN (
        SELECT session_id
        FROM sessions
        GROUP BY session_id
        HAVING COUNT(DISTINCT project_id) > 1
      )
    `);
    assert.equal(Number(database.prepare(unsafeSessionEventIdCountSql).get()?.value), 0);
    assert.equal(
      Number(
        database
          .prepare("SELECT COUNT(*) AS value FROM sessions WHERE session_id = 'shared_session'")
          .get()?.value,
      ),
      2,
    );
  } finally {
    database.close();
  }

  console.log("D1 legacy recovery unblocks after sparse events are removed.");
}

function countGuardObjects(database) {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS value FROM sqlite_schema WHERE name = ? OR (type = 'trigger' AND name LIKE ?)",
    )
    .get(projectScopeGuardTable, `${projectScopeGuardTriggerPrefix}%`);
  return Number(row?.value);
}

function migrationNames() {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

function runDrizzle(args, outputMode) {
  const stdio = outputMode === "inherit" ? "inherit" : ["ignore", "pipe", "inherit"];
  const result = execFileSync(
    "vp",
    ["exec", "--filter", "@orange-replay/worker", "--", "drizzle-kit", ...args],
    { cwd: repoRoot, encoding: "utf8", stdio },
  );
  return typeof result === "string" ? result : "";
}

function readSchema(database) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();

  return Object.fromEntries(
    tables.map(({ name }) => {
      const columns = database
        .prepare(
          'SELECT cid, name, type, "notnull" AS not_null, dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
        )
        .all(name)
        .map((column) => ({
          name: column.name,
          type: String(column.type).toUpperCase(),
          notNull: Number(column.not_null),
          defaultValue: normalizeDefault(column.dflt_value),
          primaryKeyOrder: Number(column.pk),
          hidden: Number(column.hidden),
        }));

      const indexes = database
        .prepare(
          "SELECT name, \"unique\" AS is_unique, partial FROM pragma_index_list(?) WHERE origin = 'c' ORDER BY name",
        )
        .all(name)
        .map((indexRow) => ({
          name: indexRow.name,
          unique: Number(indexRow.is_unique),
          partial: Number(indexRow.partial),
          columns: database
            .prepare(
              'SELECT name, "desc" AS is_desc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
            )
            .all(indexRow.name)
            .map((column) => ({
              name: column.name,
              descending: Number(column.is_desc),
              collation: column.coll,
            })),
        }));

      return [name, { columns, indexes }];
    }),
  );
}

function normalizeDefault(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return String(Number(text));
  return text;
}
