#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cloudflareAuthEnvironmentNames,
  withoutCloudflareAuth,
  withoutProductionSecrets,
} from "./analytics/production-secrets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const analyticsBackendName = "ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND";

export const D1_REBUILD_ROLLBACK_STEPS = Object.freeze([
  Object.freeze({
    kind: "prepare",
    label: "Generate the reviewed D1 production config",
    command: process.execPath,
    args: ["scripts/prepare-cloudflare-build-config.mjs"],
  }),
  Object.freeze({
    kind: "prepare",
    label: "Remove analytics-only secret requirements",
    command: process.execPath,
    args: ["scripts/prepare-prod-rollback-config.mjs"],
  }),
  Object.freeze({
    kind: "deploy_rebuild",
    label: "Rebuild and deploy the D1 analytics rollback",
    command: "vp",
    args: [
      "exec",
      "--filter",
      "@orange-replay/worker",
      "--",
      "wrangler",
      "deploy",
      "--config",
      "wrangler.cloudflare-build.jsonc",
      "--env",
      "production",
      "--minify",
      "--keep-vars",
    ],
  }),
  Object.freeze({
    kind: "smoke",
    label: "Check the production API",
    command: process.execPath,
    args: ["scripts/smoke-prod-api.mjs"],
  }),
  Object.freeze({
    kind: "smoke",
    label: "Check D1 analytics",
    command: process.execPath,
    args: ["scripts/smoke-analytics-prod.mjs"],
  }),
]);

export async function runProductionD1RebuildRollback({
  environment = process.env,
  runStep = runRebuildRollbackStep,
  report = (message) => console.log(message),
} = {}) {
  const rollbackEnvironment = {
    ...environment,
    [analyticsBackendName]: "d1",
  };

  report("Starting the secondary D1 rollback from the current checkout.");
  for (const step of D1_REBUILD_ROLLBACK_STEPS) {
    report(`${step.label}.`);
    await runStep(step, rebuildRollbackStepEnvironment(step, rollbackEnvironment));
  }
  report("The rebuilt D1 rollback passed the production API and analytics smoke checks.");
}

export function rebuildRollbackStepEnvironment(step, environment) {
  const cleanEnvironment = withoutCloudflareAuth(withoutProductionSecrets(environment));
  if (step.kind === "deploy_rebuild") {
    copyEnvironmentValues(cleanEnvironment, environment, cloudflareAuthEnvironmentNames);
  } else if (step.kind === "smoke") {
    copyEnvironmentValues(cleanEnvironment, environment, [
      "ORANGE_REPLAY_PROD_API_TOKEN",
      "ORANGE_REPLAY_PROD_API_PROJECT_IDS",
    ]);
  }
  return cleanEnvironment;
}

function copyEnvironmentValues(target, source, names) {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) target[name] = value;
  }
}

function runRebuildRollbackStep(step, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, {
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
      reject(new Error(`${step.label} failed with ${signal ?? code ?? "unknown status"}.`));
    });
  });
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  try {
    await runProductionD1RebuildRollback();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
