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
  console.log(
    "Production hosted-auth, demo, API, and analytics secrets passed validation. Nothing was uploaded.",
  );
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
      options.config = path.resolve(process.cwd(), value.trim());
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printHelp();
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
    "--format",
    "json",
    "--config",
    options.config,
    "--env",
    "production",
  ]);
  const uploaded = readUploadedSecretNames(output);
  const missingNames = productionWorkerSecretNames.filter((name) => !uploaded.has(name));
  if (missingNames.length > 0) {
    throw new Error(`Missing Worker secret names: ${missingNames.join(", ")}.`);
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
  let values;
  try {
    values = JSON.parse(output);
  } catch (error) {
    throw new Error("Wrangler returned an unreadable production secret list.", { cause: error });
  }
  if (!Array.isArray(values)) {
    throw new Error("Wrangler returned an invalid production secret list.");
  }

  const names = new Set();
  for (const value of values) {
    if (typeof value?.name !== "string" || value.name.length === 0) {
      throw new Error("Wrangler returned an invalid production secret entry.");
    }
    names.add(value.name);
  }
  return names;
}

function printHelp() {
  console.log(`Usage: node scripts/check-prod-secret.mjs [options]

Validates every production hosted-auth, demo, API, and analytics value without uploading it.
The reviewed deploy uploads the full set only after the analytics gate passes.

Options:
  --validate-only       Validate local values without contacting or changing Cloudflare.
  --check-uploaded      Check that all required secret names already exist on the Worker.
  --config VALUE        Wrangler config to inspect. Default: apps/worker/wrangler.jsonc.
  --help, -h            Show this help.`);
}
