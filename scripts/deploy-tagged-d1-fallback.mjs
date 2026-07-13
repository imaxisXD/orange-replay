#!/usr/bin/env node
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRODUCTION_WORKER_NAME, readNewestD1FallbackVersion } from "./analytics/d1-fallback.mjs";
import { withoutProductionSecrets } from "./analytics/production-secrets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function deployNewestD1Fallback({
  environment = process.env,
  runCapture = captureCommand,
  run = runCommand,
  report = (message) => console.log(message),
} = {}) {
  const commandEnvironment = {
    ...withoutProductionSecrets(environment),
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_WRITE_LOGS: "false",
  };
  const versionsOutput = await runCapture(
    "vp",
    wranglerArguments([
      "versions",
      "list",
      "--name",
      PRODUCTION_WORKER_NAME,
      "--json",
      "--cwd",
      tmpdir(),
    ]),
    commandEnvironment,
  );
  const fallback = readNewestD1FallbackVersion(versionsOutput);
  report(`Deploying prepared D1 fallback version ${fallback.id}.`);
  await run(
    "vp",
    wranglerArguments([
      "versions",
      "deploy",
      `${fallback.id}@100%`,
      "--name",
      PRODUCTION_WORKER_NAME,
      "--yes",
      "--message",
      "Emergency rollback to the newest prepared D1 analytics version",
      "--cwd",
      tmpdir(),
    ]),
    commandEnvironment,
  );
  return fallback;
}

function wranglerArguments(argumentsList) {
  return ["exec", "--filter", "@orange-replay/worker", "--", "wrangler", ...argumentsList];
}

function captureCommand(command, argumentsList, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
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
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            `Worker version lookup failed with ${signal ?? code ?? "unknown status"}.`,
        ),
      );
    });
  });
}

function runCommand(command, argumentsList, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: repoRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`D1 fallback deploy failed with ${signal ?? code ?? "unknown status"}.`));
    });
  });
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  try {
    await deployNewestD1Fallback();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
