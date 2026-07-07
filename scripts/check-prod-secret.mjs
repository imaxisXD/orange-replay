#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokenSecret = "DEV_API_TOKEN";
const projectIdsSecret = "DEV_API_PROJECT_IDS";
const liveTicketSecret = "LIVE_TICKET_SECRET";
const tokenEnv = "ORANGE_REPLAY_PROD_API_TOKEN";
const projectIdsEnv = "ORANGE_REPLAY_PROD_API_PROJECT_IDS";
const liveTicketEnv = "ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET";
const pathIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

try {
  const token = readValidSecret(tokenEnv);
  const projectIds = readValidProjectIds();
  const ticketSecret = readValidSecret(liveTicketEnv);

  await putSecret(tokenSecret, token);
  await putSecret(projectIdsSecret, projectIds.join(","));
  await putSecret(liveTicketSecret, ticketSecret);

  const output = await runCapture("vp", [
    "exec",
    "--filter",
    "@orange-replay/worker",
    "--",
    "wrangler",
    "secret",
    "list",
    "--env",
    "production",
  ]);

  for (const name of [tokenSecret, projectIdsSecret, liveTicketSecret]) {
    if (!secretListIncludes(output, name)) {
      throw new Error(`${name} was not visible after secret upload.`);
    }
  }

  console.log(`Production API secrets passed validation and were uploaded.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
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

async function putSecret(name, value) {
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
      "--env",
      "production",
    ],
    `${value}\n`,
  );
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

function secretListIncludes(output, name) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === name || line.startsWith(`${name} `) || line.includes(` ${name} `));
}
