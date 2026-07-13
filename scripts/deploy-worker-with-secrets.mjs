#!/usr/bin/env node
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readWorkerDeploySecrets,
  withoutProductionSecrets,
} from "./analytics/production-secrets.mjs";
import { makeD1FallbackTag } from "./analytics/d1-fallback.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployOptions = readDeployOptions(process.argv.slice(2));
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "orange-replay-worker-secrets-"));
const secretFile = path.join(temporaryDirectory, "secrets.json");
let activeChild;
const removeSecretsOnExit = () => {
  rmSync(temporaryDirectory, { force: true, recursive: true });
};
process.once("exit", removeSecretsOnExit);
const signalHandlers = new Map(
  [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ].map(([signal, exitCode]) => [
    signal,
    () => {
      removeSecretsOnExit();
      activeChild?.kill(signal);
      process.exit(exitCode);
    },
  ]),
);
for (const [signal, handler] of signalHandlers) process.once(signal, handler);

try {
  const secretValues = readWorkerDeploySecrets(process.env, {
    cloudflareBuild: deployOptions.cloudflareBuild,
  });
  const secretArguments = [];
  if (Object.keys(secretValues).length > 0) {
    await writeFile(secretFile, `${JSON.stringify(secretValues)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    secretArguments.push("--secrets-file", secretFile);
  }

  await run(
    "vp",
    workerCommandArguments(deployOptions, secretArguments),
    withoutProductionSecrets(),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
  process.off("exit", removeSecretsOnExit);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}

function run(command, argumentsList, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: repoRoot,
      env: environment,
      stdio: "inherit",
    });
    activeChild = child;
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Worker deploy failed with ${signal ?? code}.`));
    });
  });
}

function workerCommandArguments(options, secretArguments) {
  const actionArguments = options.uploadD1Fallback
    ? [
        "versions",
        "upload",
        "--config",
        "wrangler.d1-fallback.jsonc",
        "--env",
        "production",
        "--minify",
        "--keep-vars",
        "--tag",
        makeD1FallbackTag(),
        "--message",
        "Prepared D1 analytics fallback with no production traffic",
      ]
    : [
        "deploy",
        "--config",
        "wrangler.cloudflare-build.jsonc",
        "--env",
        "production",
        "--minify",
        "--keep-vars",
      ];
  return [
    "exec",
    "--filter",
    "@orange-replay/worker",
    "--",
    "wrangler",
    ...actionArguments,
    "--strict",
    ...secretArguments,
  ];
}

function readDeployOptions(argumentsList) {
  const options = { cloudflareBuild: false, uploadD1Fallback: false };
  for (const argument of argumentsList) {
    if (argument === "--cloudflare-build" && !options.cloudflareBuild) {
      options.cloudflareBuild = true;
      continue;
    }
    if (argument === "--upload-d1-fallback" && !options.uploadD1Fallback) {
      options.uploadD1Fallback = true;
      continue;
    }
    throw new Error(
      "Usage: node scripts/deploy-worker-with-secrets.mjs [--cloudflare-build] [--upload-d1-fallback]",
    );
  }
  return options;
}
