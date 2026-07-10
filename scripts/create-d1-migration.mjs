import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const migrationName = process.argv.slice(2).find((argument) => argument !== "--");
if (migrationName === undefined || !/^[a-z][a-z0-9_]*$/.test(migrationName)) {
  console.error("Provide a lowercase migration name, for example: vp run db:generate -- add_users");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const drizzleDir = path.join(workerDir, "drizzle");
const migrationsDir = path.join(workerDir, "migrations");
const before = drizzleMigrationDirectories();

execFileSync(
  "vp",
  [
    "exec",
    "--filter",
    "@orange-replay/worker",
    "--",
    "drizzle-kit",
    "generate",
    "--config",
    "drizzle.config.ts",
    "--name",
    migrationName,
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

const createdDirectories = drizzleMigrationDirectories().filter((name) => !before.includes(name));
if (createdDirectories.length === 0) {
  console.error("Drizzle found no schema change, so no D1 migration was created.");
  process.exit(1);
}
if (createdDirectories.length !== 1) {
  console.error(`Expected one Drizzle migration, but found ${createdDirectories.length}.`);
  process.exit(1);
}

const drizzleMigration = path.join(drizzleDir, createdDirectories[0], "migration.sql");
const nextNumber = String(highestD1MigrationNumber() + 1).padStart(4, "0");
const targetName = `${nextNumber}_${migrationName}.sql`;
const targetPath = path.join(migrationsDir, targetName);
const generatedSql = readFileSync(drizzleMigration, "utf8").trim();
const sourcePath = path.relative(workerDir, drizzleMigration);

writeFileSync(
  targetPath,
  [
    `-- Generated from src/db/schema.ts by \`vp run db:generate -- ${migrationName}\`.`,
    `-- Drizzle source: ${sourcePath}. Wrangler is the only production migration runner.`,
    "-- Review this SQL for data loss and add any required data-preserving steps before commit.",
    generatedSql,
    "",
  ].join("\n"),
  { flag: "wx" },
);

console.log(`Created apps/worker/migrations/${targetName}.`);
console.log("Review the migration, then run vp run db:check and vp run db:migrate:local.");

function drizzleMigrationDirectories() {
  return readdirSync(drizzleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => /^\d{14}_[a-z0-9_]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function highestD1MigrationNumber() {
  const numbers = readdirSync(migrationsDir)
    .map((name) => /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]));
  return Math.max(0, ...numbers);
}
