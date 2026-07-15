#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  productionWorkerSecretNames,
  retiredProductionWorkerSecretNames,
  withoutProductionSecrets,
} from "./analytics/production-secrets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfig = path.join(repoRoot, "apps", "worker", "wrangler.jsonc");

export async function removeRetiredProductionSecrets({
  listUploaded = () => listUploadedSecrets(defaultConfig),
  removeSecret = (name) => deleteUploadedSecret(name, defaultConfig),
} = {}) {
  const uploaded = await listUploaded();
  const missingRequired = productionWorkerSecretNames.filter((name) => !uploaded.has(name));
  if (missingRequired.length > 0) {
    throw new Error(
      `Required Better Auth-era Worker secrets are missing: ${missingRequired.join(", ")}.`,
    );
  }
  const removed = [];

  for (const name of retiredProductionWorkerSecretNames) {
    if (!uploaded.has(name)) continue;
    await removeSecret(name);
    removed.push(name);
  }

  const remaining = await listUploaded();
  const removedRequired = productionWorkerSecretNames.filter((name) => !remaining.has(name));
  if (removedRequired.length > 0) {
    throw new Error(`Required Worker secrets are missing: ${removedRequired.join(", ")}.`);
  }
  const stillUploaded = retiredProductionWorkerSecretNames.filter((name) => remaining.has(name));
  if (stillUploaded.length > 0) {
    throw new Error(`Retired Worker secrets are still present: ${stillUploaded.join(", ")}.`);
  }
  return removed;
}

async function listUploadedSecrets(config) {
  const output = await runCapture(
    wranglerArguments(["secret", "list", "--format", "json"], config),
  );
  let values;
  try {
    values = JSON.parse(output);
  } catch (error) {
    throw new Error("Wrangler returned an unreadable production secret list.", { cause: error });
  }
  if (!Array.isArray(values)) {
    throw new Error("Wrangler returned an invalid production secret list.");
  }
  return new Set(
    values.map((value) => {
      if (typeof value?.name !== "string" || value.name.length === 0) {
        throw new Error("Wrangler returned an invalid production secret entry.");
      }
      return value.name;
    }),
  );
}

async function deleteUploadedSecret(name, config) {
  await runInherited(wranglerArguments(["secret", "delete", name], config), "y\n");
}

function wranglerArguments(action, config) {
  return [
    "exec",
    "--filter",
    "@orange-replay/worker",
    "--",
    "wrangler",
    ...action,
    "--config",
    config,
    "--env",
    "production",
  ];
}

function runCapture(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn("vp", argumentsList, {
      cwd: repoRoot,
      env: withoutProductionSecrets(),
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
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Secret list failed with ${signal ?? code}.`));
    });
  });
}

function runInherited(argumentsList, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("vp", argumentsList, {
      cwd: repoRoot,
      env: withoutProductionSecrets(),
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Secret removal failed with ${signal ?? code}.`));
    });
    child.stdin.end(input);
  });
}

export function readRetiredSecretRemovalOptions(argumentsList) {
  const options = { config: defaultConfig, confirmedLogin: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--confirm-better-auth-login") {
      options.confirmedLogin = true;
      continue;
    }
    if (argument === "--config") {
      const value = argumentsList[index + 1];
      if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
        throw new Error("--config needs a file path.");
      }
      options.config = path.resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: node scripts/remove-retired-prod-secrets.mjs --confirm-better-auth-login [--config FILE]",
    );
  }
  if (!options.confirmedLogin) {
    throw new Error(
      "Confirm a real production Better Auth login first, then pass --confirm-better-auth-login.",
    );
  }
  return options;
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  try {
    const options = readRetiredSecretRemovalOptions(process.argv.slice(2));
    const removed = await removeRetiredProductionSecrets({
      listUploaded: () => listUploadedSecrets(options.config),
      removeSecret: (name) => deleteUploadedSecret(name, options.config),
    });
    console.log(
      JSON.stringify({ event: "production.retired_secrets_removed", removed, result: "pass" }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
