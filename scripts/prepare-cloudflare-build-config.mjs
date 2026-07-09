#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceConfig = path.join(repoRoot, "apps", "worker", "wrangler.jsonc");
const buildConfig = path.join(repoRoot, "apps", "worker", "wrangler.cloudflare-build.jsonc");
const replacements = [
  {
    envName: "ORANGE_REPLAY_PROD_KV_ID",
    placeholder: "REPLACE_WITH_PRODUCTION_KV_ID",
    pattern: /^[a-f0-9]{32}$/i,
    label: "production KV namespace id",
  },
  {
    envName: "ORANGE_REPLAY_PROD_D1_ID",
    placeholder: "REPLACE_WITH_PRODUCTION_D1_ID",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    label: "production D1 database id",
  },
];

try {
  let config = await readFile(sourceConfig, "utf8");

  for (const replacement of replacements) {
    const value = readBuildValue(replacement);
    if (!config.includes(replacement.placeholder)) {
      throw new Error(`${replacement.placeholder} was not found in apps/worker/wrangler.jsonc.`);
    }
    config = config.replaceAll(replacement.placeholder, value);
  }

  await writeFile(buildConfig, config, { mode: 0o600 });
  await chmod(buildConfig, 0o600);
  console.log("Cloudflare build Wrangler config generated.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function readBuildValue({ envName, pattern, label }) {
  const value = process.env[envName]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${envName} is required for the ${label}.`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${envName} is not a valid ${label}.`);
  }
  return value;
}
