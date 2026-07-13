#!/usr/bin/env node
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildNewProjectAnalyticsReceiptSql } from "./analytics/project-bootstrap.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prodEnv = "production";
const projectIdsEnv = "ORANGE_REPLAY_PROD_API_PROJECT_IDS";
let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const writeKey = options.key ?? `or_live_${randomBytes(24).toString("base64url")}`;
const keyHash = sha256Hex(writeKey);
const now = Date.now();
const allowedOrigins = options.allowAnyOrigin ? ["*"] : options.origins;
const config = {
  projectId: options.projectId,
  orgId: options.orgId,
  shard: 0,
  active: true,
  sampleRate: 1,
  allowedOrigins,
  maskPolicyVersion: 1,
  maskRules: [],
  capture: {
    heatmaps: false,
    console: false,
    network: false,
    canvas: false,
  },
  quotaState: "ok",
  retentionDays: options.retentionDays,
  version: 1,
  ...(options.jurisdiction === undefined ? {} : { jurisdiction: options.jurisdiction }),
};
const statements = [
  `INSERT INTO orgs (id, name, shard, created_at) VALUES (${sqlString(
    options.orgId,
  )}, ${sqlString(options.orgName)}, 0, ${now})`,
  `INSERT INTO projects (id, org_id, name, jurisdiction, retention_days, sample_rate, allowed_origins, mask_policy_version, mask_rules, capture_toggles, quota_state, config_version, created_at) VALUES (${sqlString(
    options.projectId,
  )}, ${sqlString(options.orgId)}, ${sqlString(options.projectName)}, ${sqlNullable(
    options.jurisdiction,
  )}, ${options.retentionDays}, 1, ${sqlString(JSON.stringify(allowedOrigins))}, 1, '[]', ${sqlString(
    JSON.stringify(config.capture),
  )}, 'ok', 1, ${now})`,
  buildNewProjectAnalyticsReceiptSql({
    projectId: options.projectId,
    createdAt: now,
    reportId: "new-project-bootstrap:production-script",
  }),
  `INSERT INTO keys (key_hash, project_id, active, created_at) VALUES (${sqlString(
    keyHash,
  )}, ${sqlString(options.projectId)}, 1, ${now})`,
];
const d1Command = `BEGIN TRANSACTION; ${statements.join(";")}; COMMIT;`;

if (options.dryRun) {
  printSummary({ saved: false });
  console.log("\nSQL:");
  console.log(`${statements.join(";\n")};`);
  console.log("\nKV key:");
  console.log(`k:${keyHash}`);
  console.log("\nKV value:");
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}

const pendingEnvFile = options.envFile === undefined ? undefined : `${options.envFile}.pending`;
try {
  if (options.envFile !== undefined && pendingEnvFile !== undefined) {
    await savePendingWriteKey(options.envFile, pendingEnvFile, writeKey);
  }

  await runWrangler([
    "d1",
    "execute",
    "IDX_00",
    "--config",
    "wrangler.jsonc",
    "--env",
    prodEnv,
    "--remote",
    "--yes",
    "--command",
    d1Command,
  ]);
  await runWrangler([
    "kv",
    "key",
    "put",
    `k:${keyHash}`,
    JSON.stringify(config),
    "--config",
    "wrangler.jsonc",
    "--env",
    prodEnv,
    "--binding",
    "CONFIG",
    "--remote",
  ]);
  if (options.envFile !== undefined && pendingEnvFile !== undefined) {
    await promotePendingWriteKey(options.envFile, pendingEnvFile);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Bootstrap did not finish.");
  if (pendingEnvFile !== undefined) {
    console.error(`The active env file was not changed. Pending key file: ${pendingEnvFile}`);
  } else if (options.key !== undefined) {
    console.error("The provided write key was not changed.");
  }
  console.error(`Possible cleanup ids: org=${options.orgId}, project=${options.projectId}`);
  console.error(`Possible cleanup key hash: ${keyHash}`);
  process.exit(1);
}

printSummary({ saved: options.envFile !== undefined });

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    key: undefined,
    projectId: defaultProjectId(),
    projectName: "Default project",
    orgId: "o1",
    orgName: "Default org",
    origins: [],
    allowAnyOrigin: false,
    retentionDays: 30,
    jurisdiction: undefined,
    envFile: "apps/worker/.env.production",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--key") {
      parsed.key = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--project-id") {
      parsed.projectId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--project-name") {
      parsed.projectName = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--org-id") {
      parsed.orgId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--org-name") {
      parsed.orgName = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--origin") {
      parsed.origins.push(readOrigin(readValue(args, index, arg), arg));
      index += 1;
      continue;
    }
    if (arg === "--allow-any-origin") {
      parsed.allowAnyOrigin = true;
      continue;
    }
    if (arg === "--retention-days") {
      parsed.retentionDays = readRetentionDays(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--jurisdiction") {
      parsed.jurisdiction = readJurisdiction(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--env-file") {
      parsed.envFile = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--no-env-file") {
      parsed.envFile = undefined;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!isSimpleId(parsed.projectId))
    throw new Error("--project-id must be letters, numbers, _, or -");
  if (!isSimpleId(parsed.orgId)) throw new Error("--org-id must be letters, numbers, _, or -");
  const deployProjectIds = readDeployProjectIds();
  if (deployProjectIds !== null && !deployProjectIds.has(parsed.projectId)) {
    throw new Error(`--project-id must be listed in ${projectIdsEnv}.`);
  }
  if (parsed.key !== undefined && !isGeneratedWriteKey(parsed.key)) {
    throw new Error("--key must be a generated key like or_live_ plus 32 base64url characters");
  }
  if (!parsed.allowAnyOrigin && parsed.origins.length === 0) {
    throw new Error("--origin is required. Use --allow-any-origin only for a public test project.");
  }
  if (parsed.envFile !== undefined) {
    parsed.envFile = readEnvFilePath(parsed.envFile);
  }
  if (!parsed.dryRun && parsed.key === undefined && parsed.envFile === undefined) {
    throw new Error("--no-env-file needs --key so the generated write key is not lost");
  }

  return parsed;
}

function readValue(args, index, arg) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} needs a value`);
  }
  return value;
}

function readRetentionDays(value, arg) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 365) {
    throw new Error(`${arg} must be a whole number from 1 to 365`);
  }
  return number;
}

function readOrigin(value, arg) {
  const trimmed = value.trim();
  if (trimmed === "*") {
    throw new Error(`${arg} cannot be *. Use --allow-any-origin only for a public test project.`);
  }

  try {
    const url = new URL(trimmed);
    const isHttpOrigin = url.protocol === "http:" || url.protocol === "https:";
    const hasOnlyOrigin =
      url.username.length === 0 &&
      url.password.length === 0 &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search.length === 0 &&
      url.hash.length === 0;
    if (isHttpOrigin && hasOnlyOrigin) {
      return url.origin;
    }
  } catch {
    // Fall through to one plain error below.
  }

  throw new Error(`${arg} must be a valid http:// or https:// origin`);
}

function readJurisdiction(value, arg) {
  if (value === "eu" || value === "fedramp") {
    return value;
  }

  throw new Error(`${arg} must be eu or fedramp`);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNullable(value) {
  return value === undefined ? "NULL" : sqlString(value);
}

function isSimpleId(value) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function defaultProjectId() {
  const projectIds = readDeployProjectIds();
  return projectIds?.values().next().value ?? "project_demo";
}

function readDeployProjectIds() {
  const value = process.env[projectIdsEnv];
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const projectIds = new Set();
  for (const part of value.split(",")) {
    const projectId = part.trim();
    if (!isSimpleId(projectId)) {
      throw new Error(
        `${projectIdsEnv} must contain only project ids with letters, numbers, _, or -`,
      );
    }
    projectIds.add(projectId);
  }

  return projectIds.size === 0 ? null : projectIds;
}

function isGeneratedWriteKey(value) {
  return /^or_live_[A-Za-z0-9_-]{32}$/.test(value);
}

function readEnvFilePath(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("--env-file needs a repo-local .env file path");
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error("--env-file must be a relative path inside this repo");
  }

  const normalized = path.normalize(trimmed);
  const fullPath = path.resolve(repoRoot, normalized);
  if (!isPathInside(repoRoot, fullPath)) {
    throw new Error("--env-file must stay inside this repo");
  }
  if (!path.basename(normalized).startsWith(".env")) {
    throw new Error("--env-file must point to an .env file");
  }

  return normalized.split(path.sep).join("/");
}

function isPathInside(parent, child) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
  );
}

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "vp",
      [
        "exec",
        "--filter",
        "@orange-replay/worker",
        "--",
        "wrangler",
        ...args,
        "--env-file",
        "wrangler.production.env",
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`wrangler ${args.join(" ")} failed with ${signal ?? code}`));
    });
  });
}

async function savePendingWriteKey(envFile, pendingEnvFile, key) {
  const fullPath = path.resolve(repoRoot, envFile);
  const pendingPath = path.resolve(repoRoot, pendingEnvFile);
  await mkdir(path.dirname(pendingPath), { recursive: true });

  let text = "";
  try {
    text = await readFile(fullPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const line = `ORANGE_REPLAY_PROD_WRITE_KEY=${JSON.stringify(key)}`;
  const existingLines = text
    .split(/\r?\n/)
    .filter(
      (existingLine) =>
        existingLine.length > 0 && !existingLine.startsWith("ORANGE_REPLAY_PROD_WRITE_KEY="),
    );
  text = `${existingLines.join("\n")}${existingLines.length > 0 ? "\n" : ""}${line}\n`;

  await writeFile(pendingPath, text, { mode: 0o600 });
  await chmod(pendingPath, 0o600);
}

async function promotePendingWriteKey(envFile, pendingEnvFile) {
  const fullPath = path.resolve(repoRoot, envFile);
  const pendingPath = path.resolve(repoRoot, pendingEnvFile);
  await rename(pendingPath, fullPath);
  await chmod(fullPath, 0o600);
}

function printSummary({ saved }) {
  console.log("\nProduction project ready.");
  console.log(`Project id: ${options.projectId}`);
  console.log(`Org id: ${options.orgId}`);
  console.log(`Write key hash: ${keyHash}`);
  if (saved) {
    console.log(`Write key: saved to ${options.envFile}`);
  } else {
    console.log("Write key: not printed.");
  }
}

function printHelp() {
  console.log(`Usage: node scripts/bootstrap-prod-project.mjs [options]

Creates the first production org, project, and SDK write key using the production Wrangler environment.
The script is insert-only and fails if the org, project, or key already exists.

Options:
  --dry-run                 Print the SQL and KV value without writing.
  --key VALUE               Use a specific write key. Default: generate one.
  --project-id VALUE        Project id. Default: first ORANGE_REPLAY_PROD_API_PROJECT_IDS value, otherwise project_demo.
  --project-name VALUE      Project name. Default: Default project.
  --org-id VALUE            Org id. Default: o1.
  --org-name VALUE          Org name. Default: Default org.
  --origin VALUE            Allowed SDK origin. Repeat for multiple. Must be http:// or https://.
  --allow-any-origin        Allow SDK ingest from any origin. Use only for a public test project.
  --retention-days VALUE    Retention days. Default: 30.
  --jurisdiction VALUE      Optional Durable Object jurisdiction, for example eu.
  --env-file VALUE          Save the write key to this ignored repo-local .env file. Default: apps/worker/.env.production.
  --no-env-file             Do not save the key. Requires --key unless this is --dry-run.
`);
}
