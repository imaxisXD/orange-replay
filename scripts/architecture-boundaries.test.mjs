import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerSourceDirectory = path.resolve(scriptsDirectory, "../apps/worker/src");
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

  it("keeps public-page storage rules in the publication owner", async () => {
    const sourcePaths = await listTypeScriptFiles(workerSourceDirectory);
    const allowedTableOwners = new Set([
      "db/schema.ts",
      "public-page/publication.ts",
      "test/database-schema.ts",
    ]);
    const invalidTableOwners = [];

    for (const sourcePath of sourcePaths) {
      const relativePath = path.relative(workerSourceDirectory, sourcePath);
      if (allowedTableOwners.has(relativePath)) continue;
      const source = await readFile(sourcePath, "utf8");
      if (/\b(?:project_public_pages|public_page_sessions)\b/u.test(source)) {
        invalidTableOwners.push(relativePath);
      }
    }

    expect(invalidTableOwners).toEqual([]);

    const publicationSource = await readFile(
      path.join(workerSourceDirectory, "public-page/publication.ts"),
      "utf8",
    );
    expect(publicationSource).not.toMatch(/from\s+["']\.\.\/api\//u);
  });

  it("keeps analytics erasure transitions in one owner", async () => {
    const sourcePaths = await listTypeScriptFiles(workerSourceDirectory);
    const transitionOwner = "analytics/erasure-lifecycle.ts";
    const jobMutation =
      /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+analytics_deletion_jobs\b/iu;
    const invalidTransitionOwners = [];

    for (const sourcePath of sourcePaths) {
      const relativePath = path.relative(workerSourceDirectory, sourcePath);
      if (relativePath === transitionOwner) continue;
      const source = await readFile(sourcePath, "utf8");
      if (jobMutation.test(source)) invalidTransitionOwners.push(relativePath);
    }

    expect(invalidTransitionOwners).toEqual([]);

    const ownerSource = await readFile(path.join(workerSourceDirectory, transitionOwner), "utf8");
    expect(ownerSource).not.toMatch(
      /from\s+["'](?:\.\.\/(?:api|consumer)\/|\.\.\/env\.ts|\.\/(?:deletion-v2|maintenance|purge-api|purge-jobs|r2-sql-client|rate-limited-pipeline|runtime)\.ts)/u,
    );
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
