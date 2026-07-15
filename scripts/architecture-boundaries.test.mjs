import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const analyticsDirectory = path.resolve(scriptsDirectory, "../apps/worker/src/analytics");

describe("Worker architecture boundaries", () => {
  it("keeps analytics policy independent from API route modules", async () => {
    const sourcePaths = await listTypeScriptFiles(analyticsDirectory);
    const invalidImports = [];

    for (const sourcePath of sourcePaths) {
      const source = await readFile(sourcePath, "utf8");
      if (/from\s+["']\.\.\/api\//u.test(source)) {
        invalidImports.push(path.relative(analyticsDirectory, sourcePath));
      }
    }

    expect(invalidImports).toEqual([]);
  });
});

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listTypeScriptFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      paths.push(entryPath);
    }
  }

  return paths.sort((left, right) => left.localeCompare(right));
}
