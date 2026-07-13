#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readAnalyticsDeployMode } from "./analytics/deploy-mode.mjs";
import { buildD1FallbackConfig } from "./analytics/rollback-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectedConfig = path.join(repoRoot, "apps", "worker", "wrangler.cloudflare-build.jsonc");
const fallbackConfig = path.join(repoRoot, "apps", "worker", "wrangler.d1-fallback.jsonc");

try {
  const { backend } = readAnalyticsDeployMode();
  const config = await readFile(selectedConfig, "utf8");
  await writeFile(fallbackConfig, buildD1FallbackConfig(config, backend), { mode: 0o600 });
  await chmod(fallbackConfig, 0o600);
  console.log("Prepared the private D1 fallback config.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
