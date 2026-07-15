#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPrivateRegularFile, writePrivateFileAtomically } from "./private-file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultFiles = [
  path.join(repoRoot, "apps", "worker", ".env"),
  path.join(repoRoot, "apps", "worker", ".env.production"),
];
const RETIRED_LOCAL_AUTH_NAMES = new Set([
  "DEV_API_TOKEN",
  "DEV_API_PROJECT_IDS",
  "ORANGE_REPLAY_PROD_API_TOKEN",
  "ORANGE_REPLAY_PROD_API_PROJECT_IDS",
]);

export function stripRetiredLocalAuth(contents) {
  const removed = [];
  const lines = contents.split("\n");
  const kept = lines.filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    const name = match?.[1];
    if (name === undefined || !RETIRED_LOCAL_AUTH_NAMES.has(name)) return true;
    if (!removed.includes(name)) removed.push(name);
    return false;
  });
  return { contents: kept.join("\n"), removed };
}

export async function scrubRetiredLocalAuth(filePaths = defaultFiles) {
  const report = [];
  for (const filePath of filePaths) {
    const current = await readPrivateRegularFile(filePath);
    const result = stripRetiredLocalAuth(current);
    if (result.removed.length > 0) {
      await writePrivateFileAtomically(filePath, result.contents);
    }
    report.push({ file: path.relative(repoRoot, filePath), removed: result.removed });
  }
  return report;
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  try {
    const report = await scrubRetiredLocalAuth();
    console.log(JSON.stringify({ event: "local.retired_auth_scrubbed", files: report }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
