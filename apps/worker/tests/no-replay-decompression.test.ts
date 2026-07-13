import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(workerRoot, "../..");
const forbidden = /\b(?:DecompressionStream|gunzip|inflateRaw|inflate)\b/;

describe("analytics privacy boundary", () => {
  it("does not decompress replay payloads in Worker or analytics backfill code", async () => {
    const files = [
      ...(await sourceFiles(path.join(workerRoot, "src"))),
      ...(await matchingFiles(path.join(repoRoot, "scripts"), /analytics|backfill/i)),
    ];
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (forbidden.test(source)) {
        violations.push(path.relative(repoRoot, file));
      }
    }

    expect(violations).toEqual([]);
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(fullPath)));
    } else if (/\.(?:ts|mts|js|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function matchingFiles(directory: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name) && !entry.name.includes(".test."))
    .map((entry) => path.join(directory, entry.name));
}
