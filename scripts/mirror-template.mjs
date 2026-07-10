#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultTemplateDir, sourceMigrationsPath, workerDir } from "./mirror-template/paths.mjs";
import {
  buildTemplateFiles,
  compareDirectories,
  writeGeneratedTemplate,
} from "./mirror-template/sync-template.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, "..");

if (isMain(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const exitCode = options.check ? await checkTemplate(options) : await writeTemplate(options);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function writeTemplate(options) {
  const root = options.root;
  const outDir = options.outDir;
  const stamp = options.stamp;
  const generated = await buildTemplateFiles(root, stamp);

  await rm(outDir, { force: true, recursive: true });
  await writeGeneratedTemplate(generated, outDir);

  console.log(`Mirrored self-host template to ${relative(root, outDir) || "."}`);
  return 0;
}

export async function checkTemplate(options) {
  const tempParent = await mkdtemp(join(tmpdir(), "orange-replay-template-"));
  const tempOut = join(tempParent, "template");

  try {
    const generated = await buildTemplateFiles(options.root, options.stamp);
    await writeGeneratedTemplate(generated, tempOut);

    const changes = await compareDirectories(tempOut, options.outDir);
    if (changes.length === 0) {
      console.log(`${relative(options.root, options.outDir) || "."} is up to date.`);
      return 0;
    }

    console.error("Self-host template is out of date. Run `node scripts/mirror-template.mjs`.");
    for (const change of changes.slice(0, 20)) {
      console.error(`- ${change}`);
    }
    if (changes.length > 20) {
      console.error(`- ...and ${changes.length - 20} more`);
    }
    return 1;
  } finally {
    await rm(tempParent, { force: true, recursive: true });
  }
}

function parseArgs(args) {
  const options = {
    check: false,
    allowTestOutput: false,
    outDir: undefined,
    root: defaultRoot,
    stamp: "unstamped",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--stamp") {
      options.stamp = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      options.outDir = resolveCliPath(readArgValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--allow-test-output") {
      options.allowTestOutput = true;
      continue;
    }
    if (arg === "--root") {
      options.root = resolveCliPath(readArgValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  options.outDir ??= resolve(options.root, defaultTemplateDir);
  assertSafeOutputDir(options.root, options.outDir, options.allowTestOutput);
  return options;
}

function readArgValue(args, index, arg) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} needs a value`);
  }
  return value;
}

function resolveCliPath(value) {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function assertSafeOutputDir(root, outDir, allowTestOutput = false) {
  const cleanRoot = resolve(root);
  const cleanOutDir = resolve(outDir);
  const defaultOutDir = resolve(cleanRoot, defaultTemplateDir);
  const blockedPaths = [
    cleanRoot,
    resolve(cleanRoot, workerDir),
    resolve(cleanRoot, sourceMigrationsPath),
    resolve(cleanRoot, "apps"),
    resolve(cleanRoot, "packages"),
    resolve(cleanRoot, "scripts"),
  ];

  if (samePath(cleanOutDir, defaultOutDir)) {
    return;
  }

  if (
    blockedPaths.some((blockedPath) => isBlockedSourceOutput(cleanRoot, blockedPath, cleanOutDir))
  ) {
    throw new Error("--out cannot point at repo source directories");
  }

  if (allowTestOutput) {
    if (samePath(cleanOutDir, cleanRoot) || isPathInside(cleanRoot, cleanOutDir)) {
      throw new Error("--out test directory cannot be inside the repo root");
    }
    if (!hasTemplateTestParent(cleanOutDir)) {
      throw new Error("--out test directory must be under an orange-replay template test folder");
    }
    return;
  }

  if (!isPathInside(cleanRoot, cleanOutDir)) {
    throw new Error("--out must be infra/template or a temporary test directory");
  }

  throw new Error("--out is only supported for infra/template or temporary test directories");
}

function isBlockedSourceOutput(root, blockedPath, outDir) {
  const cleanRoot = resolve(root);
  const cleanBlockedPath = resolve(blockedPath);
  const cleanOutDir = resolve(outDir);
  if (samePath(cleanBlockedPath, cleanOutDir)) {
    return true;
  }
  return !samePath(cleanBlockedPath, cleanRoot) && isPathInside(cleanBlockedPath, cleanOutDir);
}

function samePath(left, right) {
  return resolve(left) === resolve(right);
}

function isPathInside(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function hasTemplateTestParent(outDir) {
  return resolve(outDir)
    .split(sep)
    .some((part) => part.startsWith("orange-replay-template-test-"));
}

function printHelp() {
  console.log(`Usage: node scripts/mirror-template.mjs [--check] [--stamp ISO_OR_UNSTAMPED] [--out DIR]

Creates infra/template from apps/worker so the self-host template cannot drift.

Options:
  --check              Compare the current template with freshly generated output.
  --stamp VALUE        Manifest generatedAt value. Default: unstamped.
  --out DIR            Template output directory. Default: infra/template.
  --allow-test-output  Allow --out under an orange-replay template test folder.
`);
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === metaUrl;
}
