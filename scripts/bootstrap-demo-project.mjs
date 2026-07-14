#!/usr/bin/env node
// This script touches production Cloudflare resources. Review and test it with
// --dry-run before running it against a real account.
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildNewProjectAnalyticsReceiptSql } from "./analytics/project-bootstrap.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prodEnv = "production";
const workerUrlEnv = "ORANGE_REPLAY_PROD_WORKER_URL";
const demoProjectIdEnv = "ORANGE_REPLAY_DEMO_PROJECT_ID";
const demoWriteKeyEnv = "ORANGE_REPLAY_DEMO_WRITE_KEY";
let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const writeKey = options.key ?? `or_live_${randomBytes(24).toString("base64url")}`;
const keyHash = sha256Hex(writeKey);
const keyId = `key_${randomUUID()}`;
const now = Date.now();
const allowedOrigins = [options.origin];
const captureToggles = {
  heatmaps: false,
  console: false,
  network: false,
  canvas: false,
};
const statements = [
  `INSERT INTO orgs (id, name, slug, logo, metadata, shard, created_at) VALUES (${sqlString(
    options.orgId,
  )}, ${sqlString(options.orgName)}, ${sqlString(workspaceSlug(options.orgName, options.orgId))}, NULL, NULL, 0, ${now})`,
  `INSERT INTO projects (id, org_id, name, jurisdiction, retention_days, sample_rate, allowed_origins, mask_policy_version, mask_rules, capture_toggles, quota_state, config_version, created_at) VALUES (${sqlString(
    options.projectId,
  )}, ${sqlString(options.orgId)}, ${sqlString(
    options.projectName,
  )}, NULL, 2, 1, ${sqlString(JSON.stringify(allowedOrigins))}, 1, '[]', ${sqlString(
    JSON.stringify(captureToggles),
  )}, 'ok', 1, ${now})`,
  buildNewProjectAnalyticsReceiptSql({
    projectId: options.projectId,
    createdAt: now,
    reportId: "new-project-bootstrap:demo-script",
  }),
  `INSERT INTO keys (id, key_hash, project_id, name, active, created_at, created_by, revoked_at, revoked_by, cache_synced, cache_final_check_at) VALUES (${sqlString(
    keyId,
  )}, ${sqlString(keyHash)}, ${sqlString(options.projectId)}, 'Demo write key', 1, ${now}, NULL, NULL, NULL, 0, 0)`,
];
const d1Command = `BEGIN TRANSACTION; ${statements.join(";")}; COMMIT;`;

if (options.dryRun) {
  printSummary({ saved: false });
  console.log("\nSQL:");
  console.log(`${statements.join(";\n")};`);
  console.log("\nThe Worker cache repair will add this key to KV.");
  process.exit(0);
}

const pendingEnvFile = options.envFile === undefined ? undefined : `${options.envFile}.pending`;
try {
  if (options.envFile !== undefined && pendingEnvFile !== undefined) {
    await savePendingDemoEnv(options.envFile, pendingEnvFile, options.projectId, writeKey);
  }

  await runWrangler([
    "d1",
    "execute",
    "IDX_00",
    "--config",
    options.config,
    "--env",
    prodEnv,
    "--remote",
    "--yes",
    "--command",
    d1Command,
  ]);
  if (options.envFile !== undefined && pendingEnvFile !== undefined) {
    await promotePendingDemoEnv(options.envFile, pendingEnvFile);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Demo bootstrap did not finish.");
  if (pendingEnvFile !== undefined) {
    console.error(`The active env file was not changed. Pending key file: ${pendingEnvFile}`);
  } else if (options.key !== undefined) {
    console.error("The provided demo write key was not changed.");
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
    projectId: "demo_project",
    projectName: "Public demo project",
    orgId: "demo_org",
    orgName: "Public demo org",
    origin: undefined,
    envFile: "apps/worker/.env.production",
    config: path.join(repoRoot, "apps", "worker", "wrangler.jsonc"),
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
      parsed.origin = readOrigin(readValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--env-file") {
      parsed.envFile = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--config") {
      const configPath = readValue(args, index, arg).trim();
      if (configPath.length === 0) throw new Error("--config needs a file path");
      parsed.config = path.resolve(process.cwd(), configPath);
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
  if (parsed.key !== undefined && !isGeneratedWriteKey(parsed.key)) {
    throw new Error("--key must be a generated key like or_live_ plus 32 base64url characters");
  }
  parsed.origin = parsed.origin ?? readProductionLandingOrigin();
  if (parsed.envFile !== undefined) {
    parsed.envFile = readEnvFilePath(parsed.envFile);
  }
  if (!parsed.dryRun && parsed.key === undefined && parsed.envFile === undefined) {
    throw new Error("--no-env-file needs --key so the generated demo write key is not lost");
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

function readProductionLandingOrigin() {
  const value = process.env[workerUrlEnv];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${workerUrlEnv} is required, or pass --origin.`);
  }
  return readOrigin(value, workerUrlEnv);
}

function readOrigin(value, arg) {
  const trimmed = value.trim();
  if (trimmed === "*") {
    throw new Error(`${arg} cannot be * for the public demo project.`);
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

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceSlug(name, id) {
  const readable = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${readable || "workspace"}-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function isSimpleId(value) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
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
      ["exec", "--filter", "@orange-replay/worker", "--", "wrangler", ...args],
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

async function savePendingDemoEnv(envFile, pendingEnvFile, projectId, key) {
  const fullPath = path.resolve(repoRoot, envFile);
  const pendingPath = path.resolve(repoRoot, pendingEnvFile);
  await mkdir(path.dirname(pendingPath), { recursive: true });

  let text = "";
  try {
    text = await readFile(fullPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const lines = [
    `${demoProjectIdEnv}=${JSON.stringify(projectId)}`,
    `${demoWriteKeyEnv}=${JSON.stringify(key)}`,
  ];
  const existingLines = text
    .split(/\r?\n/)
    .filter(
      (existingLine) =>
        existingLine.length > 0 &&
        !existingLine.startsWith(`${demoProjectIdEnv}=`) &&
        !existingLine.startsWith(`${demoWriteKeyEnv}=`),
    );
  text = `${existingLines.join("\n")}${existingLines.length > 0 ? "\n" : ""}${lines.join("\n")}\n`;

  await writeFile(pendingPath, text, { mode: 0o600 });
  await chmod(pendingPath, 0o600);
}

async function promotePendingDemoEnv(envFile, pendingEnvFile) {
  const fullPath = path.resolve(repoRoot, envFile);
  const pendingPath = path.resolve(repoRoot, pendingEnvFile);
  await rename(pendingPath, fullPath);
  await chmod(fullPath, 0o600);
}

function printSummary({ saved }) {
  console.log("\nDemo production project ready.");
  console.log(`Project id: ${options.projectId}`);
  console.log(`Org id: ${options.orgId}`);
  console.log(`Landing origin: ${options.origin}`);
  console.log(`Wrangler config: ${displayPath(options.config)}`);
  console.log(`Write key hash: ${keyHash}`);
  if (saved) {
    console.log(`Demo env values: saved to ${options.envFile}`);
  } else {
    console.log("Demo write key: not printed.");
  }
  printDeployInstructions({ saved });
}

function printDeployInstructions({ saved }) {
  if (options.dryRun) {
    console.log("\nDry run only. No demo values were saved or uploaded.");
    return;
  }

  console.log("\nLoad the demo values before running the production deploy:");
  if (saved) {
    console.log(`set -a && . ${options.envFile} && set +a`);
    console.log("The deploy command uploads both demo values with the hosted-auth secrets.");
    return;
  }

  console.log(`export ${demoProjectIdEnv}=${options.projectId}`);
  console.log(`export ${demoWriteKeyEnv}='the same value passed with --key'`);
  console.log("The deploy command uploads both demo values with the hosted-auth secrets.");
}

function displayPath(value) {
  const relativePath = path.relative(repoRoot, value);
  if (relativePath.length > 0 && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join("/");
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/bootstrap-demo-project.mjs [options]

Creates the public demo production org, project, and SDK write key using the production Wrangler environment.
The script is insert-only and fails if the org, project, or key already exists.

Options:
  --dry-run                 Print the SQL without writing.
  --key VALUE               Use a specific demo write key. Default: generate one.
  --project-id VALUE        Demo project id. Default: demo_project.
  --project-name VALUE      Demo project name. Default: Public demo project.
  --org-id VALUE            Demo org id. Default: demo_org.
  --org-name VALUE          Demo org name. Default: Public demo org.
  --origin VALUE            Production landing origin. Default: ORANGE_REPLAY_PROD_WORKER_URL.
  --env-file VALUE          Save demo env values to this ignored repo-local .env file. Default: apps/worker/.env.production.
  --no-env-file             Do not save the key. Requires --key unless this is --dry-run.
  --config VALUE            Wrangler config with the real production resource ids. Default: apps/worker/wrangler.jsonc.
`);
}
