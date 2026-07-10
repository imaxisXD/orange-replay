import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseJsonc } from "./jsonc.mjs";
import { sourceMigrationsPath, sourceWranglerPath } from "./paths.mjs";
import { buildTemplateReadme, buildTemplateWrangler } from "./render-template.mjs";

export async function buildTemplateFiles(root, stamp) {
  const wranglerPath = join(root, sourceWranglerPath);
  const migrationsDir = join(root, sourceMigrationsPath);
  const sourceWrangler = await readFile(wranglerPath, "utf8");
  const sourceConfig = parseJsonc(sourceWrangler, sourceWranglerPath);
  const sourceHash = await hashInputs(root);

  return {
    manifest: { sourceHash, generatedAt: stamp },
    migrationsDir,
    readme: buildTemplateReadme(),
    wrangler: buildTemplateWrangler(sourceConfig),
  };
}

async function hashInputs(root) {
  const inputFiles = [
    join(root, sourceWranglerPath),
    ...(await listFiles(join(root, sourceMigrationsPath))),
  ].sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const hash = createHash("sha256");

  for (const file of inputFiles) {
    const relativePath = relative(root, file).split(sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return hash.digest("hex");
}

export async function writeGeneratedTemplate(generated, outDir) {
  await mkdir(outDir, { recursive: true });
  await cp(generated.migrationsDir, join(outDir, "migrations"), { recursive: true });
  await writeFile(join(outDir, "wrangler.jsonc"), generated.wrangler, "utf8");
  await writeFile(join(outDir, "README.md"), generated.readme, "utf8");
  await writeFile(
    join(outDir, ".mirror-manifest.json"),
    `${JSON.stringify(generated.manifest, null, 2)}\n`,
    "utf8",
  );
}

export async function compareDirectories(expectedDir, actualDir) {
  const expected = await snapshotFiles(expectedDir);
  const actual = await snapshotFiles(actualDir);
  const changes = [];
  const paths = new Set([...expected.keys(), ...actual.keys()]);

  for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
    const expectedFile = expected.get(path);
    const actualFile = actual.get(path);

    if (expectedFile === undefined) {
      changes.push(`extra file: ${path}`);
      continue;
    }
    if (actualFile === undefined) {
      changes.push(`missing file: ${path}`);
      continue;
    }
    if (!expectedFile.equals(actualFile)) {
      changes.push(`changed file: ${path}${firstChangedLine(expectedFile, actualFile)}`);
    }
  }

  return changes;
}

async function snapshotFiles(dir) {
  const files = new Map();
  if (!(await exists(dir))) {
    return files;
  }

  for (const file of await listFiles(dir)) {
    files.set(relative(dir, file).split(sep).join("/"), await readFile(file));
  }

  return files;
}

async function listFiles(dir) {
  const output = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      output.push(path);
    }
  }

  return output;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function firstChangedLine(expected, actual) {
  const expectedLines = expected.toString("utf8").split("\n");
  const actualLines = actual.toString("utf8").split("\n");
  const length = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < length; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return ` near line ${index + 1}`;
    }
  }

  return "";
}
