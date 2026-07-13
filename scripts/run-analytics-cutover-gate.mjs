#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  exactWorkerR2TokenEnvironment,
  needsAnalyticsCutoverCheck,
  productionAcceptanceArguments,
} from "./analytics/cutover-gate.mjs";
import { readAnalyticsDeployMode } from "./analytics/deploy-mode.mjs";
import {
  readProductionR2SqlToken,
  withoutProductionSecrets,
} from "./analytics/production-secrets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = path.join(repoRoot, "scripts", "verify-analytics-backfill.mjs");

try {
  const { backend } = readAnalyticsDeployMode();
  if (!needsAnalyticsCutoverCheck(backend)) {
    console.log(`Analytics cutover check skipped because the read backend is ${backend}.`);
    process.exit(0);
  }

  const workerR2Token = readProductionR2SqlToken();
  console.log("Checking all production D1 analytics rows against R2 SQL before cutover.");
  const result = spawnSync(process.execPath, [verifierPath, ...productionAcceptanceArguments], {
    cwd: repoRoot,
    env: exactWorkerR2TokenEnvironment(withoutProductionSecrets(), workerR2Token),
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.signal === null
        ? "R2 analytics cutover stopped because the full D1 and R2 check did not pass."
        : `R2 analytics cutover check stopped with signal ${result.signal}.`,
    );
  }
  console.log("The full D1 and R2 analytics check passed. Cutover may continue.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
