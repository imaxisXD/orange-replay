#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  productionWorkerSecretNames,
  readProductionSecretValues,
  withoutProductionSecrets,
} from "./analytics/production-secrets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfig = path.join(repoRoot, "apps", "worker", "wrangler.jsonc");

try {
  const options = readOptions(process.argv.slice(2));
  if (options.checkUploaded) {
    await confirmUploadedSecrets(options);
    console.log("All required production Worker secret names are present.");
    process.exit(0);
  }

  readProductionSecretValues();
  console.log("Production API and analytics secrets passed validation. Nothing was uploaded.");
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
  for (const name of productionWorkerSecretNames) {
    if (!uploaded.has(name)) {
      throw new Error(`${name} was not visible after secret upload.`);
    }
  }
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: withoutProductionSecrets(),
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
    child.stdin.end();
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
