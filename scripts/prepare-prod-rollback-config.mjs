#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { withoutAnalyticsSecretRequirement } from "./analytics/rollback-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "apps", "worker", "wrangler.cloudflare-build.jsonc");

try {
  const config = await readFile(configPath, "utf8");
  await writeFile(configPath, withoutAnalyticsSecretRequirement(config), { mode: 0o600 });
  await chmod(configPath, 0o600);
  console.log("Emergency D1 config no longer requires analytics-only Worker secrets.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
