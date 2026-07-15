#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readAnalyticsDeployMode } from "./analytics/deploy-mode.mjs";
import { buildD1FallbackConfig } from "./analytics/rollback-config.mjs";
import { readPrivateRegularFile, writePrivateFileAtomically } from "./private-file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectedConfig = path.join(repoRoot, "apps", "worker", "wrangler.cloudflare-build.jsonc");
const fallbackConfig = path.join(repoRoot, "apps", "worker", "wrangler.d1-fallback.jsonc");

export async function prepareD1FallbackConfig({
  environment = process.env,
  selectedConfigPath = selectedConfig,
  fallbackConfigPath = fallbackConfig,
} = {}) {
  const { backend } = readAnalyticsDeployMode(environment);
  const config = await readPrivateRegularFile(selectedConfigPath);
  await writePrivateFileAtomically(fallbackConfigPath, buildD1FallbackConfig(config, backend));
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  try {
    await prepareD1FallbackConfig();
    console.log("Prepared the private D1 fallback config.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
