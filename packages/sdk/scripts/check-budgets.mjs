import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

const budgets = [
  {
    // Revised from the original 20KB target (judge decision, 2026-07-04):
    // measured 30.07KB gz with the full rrweb 2.1.0 record path — already
    // lighter than rrweb-based competitors (40-60KB). Roadmap: fork-side
    // stripping (iframe/shadow-DOM/legacy paths) chips this down further.
    name: "core ESM bundle",
    file: "dist/orange-replay.js",
    limitBytes: 32 * 1024,
  },
  {
    name: "loader runtime",
    file: "dist/loader-runtime.js",
    limitBytes: 2 * 1024,
  },
];

await runBuild();

let failed = false;

for (const budget of budgets) {
  const filePath = resolve(packageDir, budget.file);
  const bytes = await readFile(filePath);
  const gzipBytes = gzipSync(bytes, { level: 9 }).byteLength;
  const verdict = gzipBytes <= budget.limitBytes ? "PASS" : "FAIL";

  console.log(
    `${budget.name}: ${formatBytes(gzipBytes)} gz / ${formatBytes(budget.limitBytes)} limit ${verdict}`,
  );

  if (gzipBytes > budget.limitBytes) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}

function runBuild() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["scripts/build-browser.mjs"], {
      cwd: packageDir,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`SDK build failed with ${signal ?? `exit code ${code ?? "unknown"}`}`));
    });
  });
}

function formatBytes(value) {
  return `${(value / 1024).toFixed(2)}KB`;
}
