import { execFileSync } from "node:child_process";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandArgs = process.argv.slice(2).filter((argument) => argument !== "--");
const databaseName = commandArgs.shift();

if (databaseName === undefined || databaseName.startsWith("-")) {
  console.error(
    "Provide the D1 database name, for example: node scripts/apply-d1-migrations.mjs orange-replay-idx-00 --local",
  );
  process.exit(1);
}

const wranglerOptions = resolvePathOptions(commandArgs, process.cwd());
const hasMigrationsTable = queryNumber(migrationsTableExistsSql) > 0;
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

function queryNumber(sql) {
  const parsed = executeSql(sql);
  const firstResult = parsed[0];
  const rawValue = firstResult?.results?.[0]?.value;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Wrangler returned an invalid D1 safety-check result.");
  }

  return value;
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
    ["exec", "--filter", "@orange-replay/worker", "--", "wrangler", ...args],
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
