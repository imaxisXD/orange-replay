#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfig = path.join(repoRoot, "apps", "worker", "wrangler.jsonc");
const tokenSecret = "DEV_API_TOKEN";
const projectIdsSecret = "DEV_API_PROJECT_IDS";
const liveTicketSecret = "LIVE_TICKET_SECRET";
const r2SqlSecret = "R2_SQL_TOKEN";
const purgeRunnerSecret = "ANALYTICS_PURGE_RUNNER_TOKEN";
const tokenEnv = "ORANGE_REPLAY_PROD_API_TOKEN";
const projectIdsEnv = "ORANGE_REPLAY_PROD_API_PROJECT_IDS";
const liveTicketEnv = "ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET";
const r2SqlEnv = "ORANGE_REPLAY_PROD_R2_SQL_TOKEN";
const purgeRunnerEnv = "ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN";
const pathIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

try {
  const options = readOptions(process.argv.slice(2));
  if (options.checkUploaded) {
    await confirmUploadedSecrets(options);
    console.log("All required production Worker secret names are present.");
    process.exit(0);
  }

  const token = readValidSecret(tokenEnv);
  const projectIds = readValidProjectIds();
  const ticketSecret = readValidSecret(liveTicketEnv);
  const r2SqlToken = readValidSecret(r2SqlEnv);
  const purgeRunnerToken = readValidSecret(purgeRunnerEnv);

  if (options.validateOnly) {
    console.log("Production API and analytics secrets passed validation. Nothing was uploaded.");
    process.exit(0);
  }

  await putSecret(tokenSecret, token, options);
  await putSecret(projectIdsSecret, projectIds.join(","), options);
  await putSecret(liveTicketSecret, ticketSecret, options);
  await putSecret(r2SqlSecret, r2SqlToken, options);
  await putSecret(purgeRunnerSecret, purgeRunnerToken, options);
  await confirmUploadedSecrets(options);

  console.log(`Production API and analytics secrets passed validation and were uploaded.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function readOptions(args) {
  const options = { checkUploaded: false, config: defaultConfig, validateOnly: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--validate-only") {
      options.validateOnly = true;
      continue;
    }
    if (argument === "--check-uploaded") {
      options.checkUploaded = true;
      continue;
    }
    if (argument === "--config") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
        throw new Error("--config needs a file path.");
      }
      options.config = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/check-prod-secret.mjs [--validate-only | --check-uploaded] [--config FILE]",
      );
      process.exit(0);
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (options.validateOnly && options.checkUploaded) {
    throw new Error("Use either --validate-only or --check-uploaded, not both.");
  }
  return options;
}

function readValidSecret(envName) {
  const token = process.env[envName];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`${envName} is required before production deploy.`);
  }
  if (token.length < 32) {
    throw new Error(`${envName} must be at least 32 characters.`);
  }
  if (token.trim() !== token || /[\r\n]/.test(token)) {
    throw new Error(`${envName} must not include surrounding space or new lines.`);
  }
  return token;
}

function readValidProjectIds() {
  const raw = process.env[projectIdsEnv];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${projectIdsEnv} is required before production deploy.`);
  }

  const projectIds = raw.split(",").map((part) => part.trim());
  if (projectIds.some((projectId) => projectId.length === 0)) {
    throw new Error(`${projectIdsEnv} must be a comma-separated list without empty values.`);
  }
  for (const projectId of projectIds) {
    if (!pathIdPattern.test(projectId)) {
      throw new Error(`${projectIdsEnv} contains an invalid project id: ${projectId}`);
    }
  }
  return [...new Set(projectIds)];
}

async function putSecret(name, value, options) {
  await runCapture(
    "vp",
    [
      "exec",
      "--filter",
      "@orange-replay/worker",
      "--",
      "wrangler",
      "secret",
      "put",
      name,
      "--config",
      options.config,
      "--env",
      "production",
    ],
    `${value}\n`,
  );
}

async function confirmUploadedSecrets(options) {
  const output = await runCapture("vp", [
    "exec",
    "--filter",
    "@orange-replay/worker",
    "--",
    "wrangler",
    "secret",
    "list",
    "--config",
    options.config,
    "--env",
    "production",
  ]);
  const uploaded = readUploadedSecretNames(output);
  for (const name of [
    tokenSecret,
    projectIdsSecret,
    liveTicketSecret,
    r2SqlSecret,
    purgeRunnerSecret,
  ]) {
    if (!uploaded.has(name)) {
      throw new Error(`${name} was not visible after secret upload.`);
    }
  }
}

function runCapture(command, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(stderr.trim() || `${command} ${args.join(" ")} failed with ${signal ?? code}`),
      );
    });
    child.stdin.end(stdin);
  });
}

function readUploadedSecretNames(output) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return new Set(
      parsed
        .map((item) => (item !== null && typeof item === "object" ? item.name : undefined))
        .filter((name) => typeof name === "string"),
    );
  } catch {
    throw new Error("Wrangler returned an unreadable production secret list.");
  }
}
