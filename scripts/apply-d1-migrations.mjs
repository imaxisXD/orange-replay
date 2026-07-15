import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  installProjectScopeRepairGuardsSql,
  migrationsTableExistsSql,
  projectScopeRepairAppliedSql,
  projectScopeRepairMigration,
  sessionEventsTableExistsSql,
  sessionsTableExistsSql,
  unsafeSessionEventIdCountSql,
} from "./d1-migration-safety.mjs";
import {
  analyticsBaseSchemaKeys,
  analyticsMigrationName,
  buildHistoryRepairSql,
  missingSchemaKeys,
  planAnalyticsDeletionJobRepair,
  planKnownMigrationHistoryRepair,
  requiredSchemaObjectNames,
  schemaObjectDifferences,
  shouldRepairLocalMigrationHistory,
} from "./local-d1-migration-repair.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDirectory = path.join(repoRoot, "apps", "worker");
const migrationsDirectory = path.join(workerDirectory, "migrations");
const requireFromHere = createRequire(import.meta.url);
const commandArgs = process.argv.slice(2).filter((argument) => argument !== "--");
const databaseName = commandArgs.shift();

if (databaseName === undefined || databaseName.startsWith("-")) {
  console.error(
    "Provide the D1 database name, for example: node scripts/apply-d1-migrations.mjs orange-replay-idx-00 --local",
  );
  process.exit(1);
}

const wranglerOptions = resolvePathOptions(commandArgs, process.cwd());
const shouldRepairLocalHistory = shouldRepairLocalMigrationHistory(wranglerOptions);
// Local commands must match the Vite plugin that writes local state. Remote commands keep the
// production Worker's pinned Wrangler version.
const wranglerWorkspace = shouldRepairLocalHistory
  ? "@orange-replay/dashboard"
  : "@orange-replay/worker";
const hasMigrationsTable = queryNumber(migrationsTableExistsSql) > 0;
if (shouldRepairLocalHistory && hasMigrationsTable) {
  repairKnownLocalMigrationDrift();
}
const repairWasApplied = hasMigrationsTable && queryNumber(projectScopeRepairAppliedSql) > 0;

if (
  !repairWasApplied &&
  queryNumber(sessionsTableExistsSql) > 0 &&
  queryNumber(sessionEventsTableExistsSql) > 0
) {
  executeSql(installProjectScopeRepairGuardsSql);
  const unsafeSessionEventIds = queryNumber(unsafeSessionEventIdCountSql);
  if (unsafeSessionEventIds > 0) {
    console.error(
      `D1 migration stopped: ${projectScopeRepairMigration} is pending, but ${unsafeSessionEventIds} cross-project session id(s) still have sparse event rows.`,
    );
    console.error(
      "Back up the database, then remove only the sparse session_events rows for those ambiguous session ids before retrying. Do not delete sessions or replay objects.",
    );
    console.error(
      "See docs/d1-migrations.md under 'Legacy project-scoped 0001 repair' for the reviewed recovery command.",
    );
    process.exit(1);
  }
}

runWrangler(["d1", "migrations", "apply", databaseName, ...wranglerOptions], "inherit");

function repairKnownLocalMigrationDrift() {
  let appliedNames = readAppliedMigrationNames();
  repairKnownAnalyticsMigrationShape(appliedNames);

  const plan = planKnownMigrationHistoryRepair(appliedNames);
  if (plan === null) return;

  for (const { to } of plan.mappings) {
    const canonicalFile = path.join(repoRoot, "apps", "worker", "migrations", to);
    if (!existsSync(canonicalFile)) {
      throw new Error(`Local D1 migration repair stopped: canonical file ${to} is missing.`);
    }
  }

  const canonicalNames = plan.mappings.map(({ to }) => to);
  const objectNames = requiredSchemaObjectNames(canonicalNames);
  const lastCanonicalName = canonicalNames.at(-1);
  if (lastCanonicalName === undefined) {
    throw new Error("Local D1 migration repair stopped: no canonical history was selected.");
  }
  const schemaDifferences = schemaObjectDifferences(
    readCanonicalSchemaObjects(lastCanonicalName, objectNames),
    readSchemaObjects(objectNames),
  );
  if (schemaDifferences.length > 0) {
    throw new Error(
      `Local D1 migration repair stopped: ${plan.historyName} schema differs from the canonical migrations: ${schemaDifferences.join(", ")}.`,
    );
  }

  executeSql(buildHistoryRepairSql(plan.mappings));
  appliedNames = readAppliedMigrationNames();
  for (const { from, to } of plan.mappings) {
    if (appliedNames.includes(from) || !appliedNames.includes(to)) {
      throw new Error(
        "Local D1 migration repair stopped: migration names were not updated safely.",
      );
    }
  }
  console.log(`Reconciled local D1 migration names from ${plan.historyName} history.`);
}

function repairKnownAnalyticsMigrationShape(appliedNames) {
  const migrationApplied = appliedNames.includes(analyticsMigrationName);
  if (!migrationApplied) return;

  const baseSchemaMissing = missingSchemaKeys(
    analyticsBaseSchemaKeys,
    readSchemaKeys(analyticsBaseSchemaKeys),
  );
  const repair = planAnalyticsDeletionJobRepair({
    migrationApplied,
    baseSchemaMissing,
    columns: readTableColumns("analytics_deletion_jobs"),
    tableSql: readTableSql("analytics_deletion_jobs"),
  });
  if (repair === "none") return;

  executeSql(`
    ALTER TABLE analytics_deletion_jobs
    ADD COLUMN requires_warehouse_tombstone INTEGER NOT NULL DEFAULT 1
      CHECK (requires_warehouse_tombstone IN (0, 1))
  `);
  const verified = planAnalyticsDeletionJobRepair({
    migrationApplied,
    baseSchemaMissing: missingSchemaKeys(
      analyticsBaseSchemaKeys,
      readSchemaKeys(analyticsBaseSchemaKeys),
    ),
    columns: readTableColumns("analytics_deletion_jobs"),
    tableSql: readTableSql("analytics_deletion_jobs"),
  });
  if (verified !== "none") {
    throw new Error(
      "Local D1 migration repair stopped: analytics migration 0009 was not repaired.",
    );
  }
  console.log("Repaired the known older local analytics migration 0009 table shape.");
}

function readAppliedMigrationNames() {
  return queryRows("SELECT name FROM d1_migrations ORDER BY id").map((row) => {
    if (typeof row.name !== "string") {
      throw new Error("Wrangler returned an invalid D1 migration history.");
    }
    return row.name;
  });
}

function readSchemaKeys(requiredKeys) {
  const tableNames = new Set();
  const indexNames = new Set();
  const columnsByTable = new Map();
  for (const key of requiredKeys) {
    const [kind, table, column] = key.split(":");
    if (kind === "table" && table !== undefined) tableNames.add(table);
    if (kind === "index" && table !== undefined) indexNames.add(table);
    if (kind === "column" && table !== undefined && column !== undefined) {
      const columns = columnsByTable.get(table) ?? [];
      columns.push(column);
      columnsByTable.set(table, columns);
    }
  }

  const rows = [];
  if (tableNames.size > 0) {
    rows.push(
      ...queryRows(
        `SELECT 'table:' || name AS schema_key FROM sqlite_schema WHERE type = 'table' AND name IN (${[...tableNames].map(sqlText).join(", ")})`,
      ),
    );
  }
  if (indexNames.size > 0) {
    rows.push(
      ...queryRows(
        `SELECT 'index:' || name AS schema_key FROM sqlite_schema WHERE type = 'index' AND name IN (${[...indexNames].map(sqlText).join(", ")})`,
      ),
    );
  }
  for (const [table, columns] of columnsByTable) {
    rows.push(
      ...queryRows(
        `SELECT ${sqlText(`column:${table}:`)} || name AS schema_key FROM pragma_table_info(${sqlText(table)}) WHERE name IN (${columns.map(sqlText).join(", ")})`,
      ),
    );
  }

  return rows.map((row) => {
    if (typeof row.schema_key !== "string") {
      throw new Error("Wrangler returned an invalid D1 schema check.");
    }
    return row.schema_key;
  });
}

function readTableColumns(table) {
  return queryRows(
    `SELECT name, type, "notnull" AS not_null, dflt_value AS default_value, pk FROM pragma_table_info(${sqlText(table)}) ORDER BY cid`,
  ).map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    notNull: Number(row.not_null),
    defaultValue: row.default_value,
    primaryKey: Number(row.pk),
  }));
}

function readTableSql(table) {
  const rows = queryRows(
    `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ${sqlText(table)}`,
  );
  if (rows.length !== 1 || typeof rows[0]?.sql !== "string") return null;
  return rows[0].sql;
}

function readSchemaObjects(objectNames) {
  if (objectNames.length === 0) return [];
  return queryRows(
    `SELECT type, name, sql FROM sqlite_schema WHERE name IN (${objectNames.map(sqlText).join(", ")}) ORDER BY type, name`,
  );
}

function readCanonicalSchemaObjects(lastMigrationName, objectNames) {
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  const lastMigrationIndex = migrationNames.indexOf(lastMigrationName);
  if (lastMigrationIndex < 0) {
    throw new Error(
      `Local D1 migration repair stopped: canonical file ${lastMigrationName} is missing.`,
    );
  }

  const { DatabaseSync } = requireFromHere("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    for (const migrationName of migrationNames.slice(0, lastMigrationIndex + 1)) {
      database.exec(readFileSync(path.join(migrationsDirectory, migrationName), "utf8"));
    }
    if (objectNames.length === 0) return [];
    const placeholders = objectNames.map(() => "?").join(", ");
    return database
      .prepare(
        `SELECT type, name, sql FROM sqlite_schema WHERE name IN (${placeholders}) ORDER BY type, name`,
      )
      .all(...objectNames);
  } catch (error) {
    throw new Error("Local D1 migration repair stopped: canonical schema could not be built.", {
      cause: error,
    });
  } finally {
    database.close();
  }
}

function queryNumber(sql) {
  const rawValue = queryRows(sql)[0]?.value;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Wrangler returned an invalid D1 safety-check result.");
  }

  return value;
}

function queryRows(sql) {
  const parsed = executeSql(sql);
  const rows = parsed[0]?.results;
  if (!Array.isArray(rows)) {
    throw new Error("Wrangler returned an invalid D1 safety-check result.");
  }
  return rows;
}

function executeSql(sql) {
  const output = runWrangler(
    ["d1", "execute", databaseName, ...wranglerOptions, "--command", sql.trim(), "--json"],
    "capture",
  );

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("Wrangler returned an unreadable D1 safety-check response.", { cause: error });
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => item.success !== true)
  ) {
    throw new Error("Wrangler returned an invalid D1 safety-check result.");
  }

  return parsed;
}

function runWrangler(args, outputMode) {
  const stdio = outputMode === "inherit" ? "inherit" : ["ignore", "pipe", "inherit"];
  const output = execFileSync(
    "vp",
    ["exec", "--filter", wranglerWorkspace, "--", "wrangler", "--cwd", workerDirectory, ...args],
    { cwd: repoRoot, encoding: "utf8", stdio },
  );
  return typeof output === "string" ? output : "";
}

function resolvePathOptions(args, callerDirectory) {
  const pathFlags = new Set(["--config", "-c", "--env-file", "--persist-to"]);
  const resolved = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;

    if (pathFlags.has(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${argument} requires a path.`);
      }
      resolved.push(argument, path.resolve(callerDirectory, value));
      index += 1;
      continue;
    }

    const pathAssignment = [...pathFlags].find((flag) => argument.startsWith(`${flag}=`));
    if (pathAssignment !== undefined) {
      const value = argument.slice(pathAssignment.length + 1);
      resolved.push(`${pathAssignment}=${path.resolve(callerDirectory, value)}`);
      continue;
    }

    resolved.push(argument);
  }

  return resolved;
}

function sqlText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
