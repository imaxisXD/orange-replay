#!/usr/bin/env node
import { copyFile, cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const landingDir = path.join(repoRoot, "landing");
const sdkBundle = path.join(repoRoot, "packages", "sdk", "dist", "orange-replay.iife.js");
const dashboardDist = path.join(repoRoot, "apps", "dashboard", "dist");
const dashboardIndex = path.join(dashboardDist, "index.html");
const dashboardAppShell = path.join(dashboardDist, "dashboard", "index.html");
const recorderAsset = path.join(dashboardDist, "or-recorder.js");
const publicPageClient = path.join(dashboardDist, "public", "public-page.js");
const publicPageStyles = path.join(dashboardDist, "public", "public-page.css");
const landingFiles = [
  "_headers",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "android-chrome-maskable-512x512.png",
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
  "index.html",
  "mstile-150x150.png",
  "site.webmanifest",
];
const landingDirectories = ["brand", "flags", "fonts"];
const dashboardEnvironment = readDashboardEnvironment(process.argv.slice(2));
const dashboardEnv = {
  ...process.env,
  VITE_DASHBOARD_ENVIRONMENT: dashboardEnvironment,
};

await run(process.execPath, ["packages/sdk/scripts/build-browser.mjs"], repoRoot);
await run("vp", ["build"], path.join(repoRoot, "apps", "dashboard"), dashboardEnv);
await run("vp", ["build"], path.join(repoRoot, "apps", "public-page"));

await assertFile(dashboardIndex, "Dashboard app shell");
await assertFile(publicPageClient, "Public page browser entry");
await assertFile(publicPageStyles, "Public page styles");
await mkdir(path.dirname(dashboardAppShell), { recursive: true });
await copyFile(dashboardIndex, dashboardAppShell);
await copyLandingAssets();

await assertFile(sdkBundle, "SDK browser bundle");
await mkdir(dashboardDist, { recursive: true });
await copyFile(sdkBundle, recorderAsset);

console.log(
  [
    `Deploy assets ready: ${path.relative(repoRoot, path.join(dashboardDist, "index.html"))}`,
    `Dashboard shell: ${path.relative(repoRoot, dashboardAppShell)}`,
    `SDK bundle: ${path.relative(repoRoot, recorderAsset)}`,
    `Public page: ${path.relative(repoRoot, publicPageClient)}`,
  ].join("\n"),
);

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
    });
  });
}

async function assertFile(file, label) {
  try {
    const info = await stat(file);
    if (info.isFile()) return;
  } catch {
    // Fall through to the clear error below.
  }

  throw new Error(`${label} was not created at ${path.relative(repoRoot, file)}`);
}

async function copyLandingAssets() {
  for (const file of landingFiles) {
    const source = path.join(landingDir, file);
    await assertFile(source, `Landing asset ${file}`);
    await copyFile(source, path.join(dashboardDist, file));
  }

  for (const directory of landingDirectories) {
    const source = path.join(landingDir, directory);
    await cp(source, path.join(dashboardDist, directory), { recursive: true });
  }
}

function readDashboardEnvironment(argumentsList) {
  if (argumentsList.length === 0) return "local";
  if (argumentsList.length === 1 && argumentsList[0] === "--production") return "production";
  throw new Error("Usage: node scripts/build-deploy.mjs [--production]");
}
