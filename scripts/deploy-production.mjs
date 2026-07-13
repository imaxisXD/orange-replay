#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readAnalyticsDeployMode } from "./analytics/deploy-mode.mjs";
import {
  cloudflareAuthEnvironmentNames,
  productionSecretEnvironmentNames,
  readProductionR2SqlToken,
  readProductionSecretValues,
  readProductionSmokeValues,
  withoutCloudflareAuth,
  withoutProductionSecrets,
} from "./analytics/production-secrets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const commonStartSteps = Object.freeze([
  Object.freeze({
    kind: "prepare",
    label: "Generate the reviewed production config",
    command: process.execPath,
    args: ["scripts/prepare-cloudflare-build-config.mjs"],
  }),
  Object.freeze({
    kind: "prepare_fallback",
    label: "Prepare the reviewed D1 fallback config",
    command: process.execPath,
    args: ["scripts/prepare-d1-fallback-config.mjs"],
  }),
]);

const normalBuildSteps = Object.freeze([
  Object.freeze({
    kind: "build",
    label: "Build the SDK and dashboard",
    command: process.execPath,
    args: ["scripts/build-deploy.mjs"],
  }),
]);

const commonDeploySteps = Object.freeze([
  Object.freeze({
    kind: "migrate",
    label: "Apply production D1 migrations",
    command: process.execPath,
    args: [
      "scripts/apply-d1-migrations.mjs",
      "orange-replay-idx-00-prod",
      "--config",
      "apps/worker/wrangler.cloudflare-build.jsonc",
      "--env",
      "production",
      "--remote",
    ],
  }),
  Object.freeze({
    kind: "gate",
    label: "Run the analytics cutover gate",
    command: process.execPath,
    args: ["scripts/run-analytics-cutover-gate.mjs"],
  }),
]);

const finishSteps = Object.freeze([
  Object.freeze({
    kind: "check_uploaded",
    label: "Check the deployed Worker secret names",
    command: process.execPath,
    args: [
      "scripts/check-prod-secret.mjs",
      "--check-uploaded",
      "--config",
      "apps/worker/wrangler.cloudflare-build.jsonc",
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
    label: "Check production analytics",
    command: process.execPath,
    args: ["scripts/smoke-analytics-prod.mjs"],
  }),
]);

export function productionDeploySteps(cloudflareBuild) {
  const beforeDeploy = cloudflareBuild
    ? [
        ...commonStartSteps,
        Object.freeze({
          kind: "check_uploaded",
          label: "Check the existing Worker secret names",
          command: process.execPath,
          args: [
            "scripts/check-prod-secret.mjs",
            "--check-uploaded",
            "--config",
            "apps/worker/wrangler.cloudflare-build.jsonc",
          ],
        }),
      ]
    : [...commonStartSteps, ...normalBuildSteps];
  return [
    ...beforeDeploy,
    ...commonDeploySteps,
    Object.freeze({
      kind: "upload_fallback",
      label: "Upload a tagged D1 fallback version without traffic",
      command: process.execPath,
      args: [
        "scripts/deploy-worker-with-secrets.mjs",
        ...(cloudflareBuild ? ["--cloudflare-build"] : []),
        "--upload-d1-fallback",
      ],
    }),
    Object.freeze({
      kind: "deploy",
      label: "Deploy the Worker and its reviewed secrets",
      command: process.execPath,
      args: [
        "scripts/deploy-worker-with-secrets.mjs",
        ...(cloudflareBuild ? ["--cloudflare-build"] : []),
      ],
    }),
    ...finishSteps,
  ];
}

export async function runProductionDeploy({
  cloudflareBuild = false,
  environment = process.env,
  runStep = runProductionStep,
  report = (message) => console.log(message),
} = {}) {
  const { backend } = readAnalyticsDeployMode(environment);
  readProductionSmokeValues(environment);
  if (cloudflareBuild) {
    if (backend === "compare" || backend === "r2_sql") {
      readProductionR2SqlToken(environment);
    }
  } else {
    readProductionSecretValues(environment);
  }

  report(`Starting the production ${backend} analytics deploy.`);
  for (const step of productionDeploySteps(cloudflareBuild)) {
    report(`${step.label}.`);
    await runStep(step, productionStepEnvironment(step, environment, backend));
  }
  report(`The production ${backend} analytics deploy and smoke checks passed.`);
}

export function productionStepEnvironment(step, environment, backend) {
  const cleanEnvironment = withoutCloudflareAuth(withoutProductionSecrets(environment));

  if (new Set(["check_uploaded", "migrate", "gate", "upload_fallback", "deploy"]).has(step.kind)) {
    copyEnvironmentValues(cleanEnvironment, environment, cloudflareAuthEnvironmentNames);
  }

  if (step.kind === "build") {
    copyEnvironmentValues(cleanEnvironment, environment, ["ORANGE_REPLAY_PROD_API_PROJECT_IDS"]);
  } else if (step.kind === "gate" && (backend === "compare" || backend === "r2_sql")) {
    copyEnvironmentValues(cleanEnvironment, environment, ["ORANGE_REPLAY_PROD_R2_SQL_TOKEN"]);
  } else if (step.kind === "deploy" || step.kind === "upload_fallback") {
    const names =
      step.args.includes("--cloudflare-build") && (backend === "compare" || backend === "r2_sql")
        ? ["ORANGE_REPLAY_PROD_R2_SQL_TOKEN"]
        : step.args.includes("--cloudflare-build")
          ? []
          : productionSecretEnvironmentNames;
    copyEnvironmentValues(cleanEnvironment, environment, names);
  } else if (step.kind === "smoke") {
    copyEnvironmentValues(cleanEnvironment, environment, [
      "ORANGE_REPLAY_PROD_API_PROJECT_IDS",
      "ORANGE_REPLAY_PROD_API_TOKEN",
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

function runProductionStep(step, environment) {
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

function readCloudflareBuildOption(argumentsList) {
  if (argumentsList.length === 0) return false;
  if (argumentsList.length === 1 && argumentsList[0] === "--cloudflare-build") return true;
  throw new Error("Usage: node scripts/deploy-production.mjs [--cloudflare-build]");
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  try {
    await runProductionDeploy({
      cloudflareBuild: readCloudflareBuildOption(process.argv.slice(2)),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
