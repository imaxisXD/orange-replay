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

export const D1_ROLLBACK_STEPS = Object.freeze([
  Object.freeze({
    kind: "deploy_tagged",
    label: "Deploy the newest prepared D1 fallback version",
    command: process.execPath,
    args: ["scripts/deploy-tagged-d1-fallback.mjs"],
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

export async function runProductionD1Rollback({
  environment = process.env,
  runStep = runRollbackStep,
  report = (message) => console.log(message),
} = {}) {
  const rollbackEnvironment = {
    ...environment,
    [analyticsBackendName]: "d1",
  };

  report("Starting the emergency rollback to the newest prepared D1 version.");
  for (const step of D1_ROLLBACK_STEPS) {
    report(`${step.label}.`);
    await runStep(step, rollbackStepEnvironment(step, rollbackEnvironment));
  }
  report("The prepared D1 rollback passed the production API and analytics smoke checks.");
}

export function rollbackStepEnvironment(step, environment) {
  const cleanEnvironment = withoutCloudflareAuth(withoutProductionSecrets(environment));
  const names = step.kind === "deploy_tagged" ? cloudflareAuthEnvironmentNames : [];
  for (const name of names) {
    const value = environment[name];
    if (value !== undefined) cleanEnvironment[name] = value;
  }
  return cleanEnvironment;
}

function runRollbackStep(step, environment) {
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
    await runProductionD1Rollback();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
