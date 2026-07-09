#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, "..");
const defaultTemplateDir = "infra/template";
const workerDir = "apps/worker";
const sourceWranglerPath = `${workerDir}/wrangler.jsonc`;
const sourceMigrationsPath = `${workerDir}/migrations`;

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
  await mkdir(outDir, { recursive: true });
  await cp(generated.migrationsDir, join(outDir, "migrations"), { recursive: true });
  await writeFile(join(outDir, "wrangler.jsonc"), generated.wrangler, "utf8");
  await writeFile(join(outDir, "README.md"), generated.readme, "utf8");
  await writeFile(
    join(outDir, ".mirror-manifest.json"),
    `${JSON.stringify(generated.manifest, null, 2)}\n`,
    "utf8",
  );

  console.log(`Mirrored self-host template to ${relative(root, outDir) || "."}`);
  return 0;
}

export async function checkTemplate(options) {
  const tempParent = await mkdtemp(join(tmpdir(), "orange-replay-template-"));
  const tempOut = join(tempParent, "template");

  try {
    const generated = await buildTemplateFiles(options.root, options.stamp);
    await mkdir(tempOut, { recursive: true });
    await cp(generated.migrationsDir, join(tempOut, "migrations"), { recursive: true });
    await writeFile(join(tempOut, "wrangler.jsonc"), generated.wrangler, "utf8");
    await writeFile(join(tempOut, "README.md"), generated.readme, "utf8");
    await writeFile(
      join(tempOut, ".mirror-manifest.json"),
      `${JSON.stringify(generated.manifest, null, 2)}\n`,
      "utf8",
    );

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

async function buildTemplateFiles(root, stamp) {
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

function buildTemplateWrangler(source) {
  const lines = ["{"];
  const schema = typeof source.$schema === "string" ? toTemplateSchema(source.$schema) : undefined;
  const sourceMain = typeof source.main === "string" ? source.main : "src/index.ts";

  if (schema !== undefined) {
    lines.push(`  "$schema": ${JSON.stringify(schema)},`);
  }
  lines.push('  "name": "orange-replay",');
  lines.push(`  "main": ${JSON.stringify(toTemplateMain(sourceMain))},`);
  pushJsonProperty(lines, "compatibility_date", source.compatibility_date, 1);

  if (source.observability !== undefined) {
    appendObject(lines, "observability", source.observability);
  }
  appendObject(
    lines,
    "version_metadata",
    source.version_metadata ?? {
      binding: "CF_VERSION_METADATA",
    },
  );

  appendDurableObjects(lines, source.durable_objects);
  appendMigrations(lines, source.migrations);
  appendR2Buckets(lines, source.r2_buckets);
  appendKvNamespaces(lines, source.kv_namespaces);
  appendD1Databases(lines, source.d1_databases);
  appendRateLimits(lines, source.ratelimits);
  appendQueues(lines, source.queues);
  appendTriggers(lines, source.triggers);
  appendSecretNotes(lines);
  lines.push("}");

  return `${lines.join("\n")}\n`;
}

function toTemplateSchema(schema) {
  return schema.startsWith("node_modules/") ? `../../${schema}` : schema;
}

function toTemplateMain(main) {
  const cleanMain = main.replace(/^\.\//, "");
  if (cleanMain.startsWith("../") || cleanMain.startsWith("/")) {
    return cleanMain;
  }
  return `../../${workerDir}/${cleanMain}`;
}

function appendDurableObjects(lines, durableObjects) {
  const bindings = Array.isArray(durableObjects?.bindings) ? durableObjects.bindings : [];
  lines.push('  "durable_objects": {');
  lines.push('    "bindings": [');
  for (const binding of bindings) {
    const cleanBinding = {
      name: binding.name,
      class_name: binding.class_name,
      script_name: binding.script_name,
    };
    lines.push(
      `      // # created by setup docs: deploy creates the ${String(
        binding.name,
      )} Durable Object namespace.`,
    );
    lines.push(`      ${inlineObject(cleanBinding)},`);
  }
  lines.push("    ],");
  lines.push("  },");
}

function appendMigrations(lines, migrations) {
  const cleanMigrations = Array.isArray(migrations) ? migrations : [];
  lines.push('  "migrations": [');
  for (const migration of cleanMigrations) {
    lines.push("    {");
    lines.push(`      "tag": ${JSON.stringify(migration.tag)},`);
    if (Array.isArray(migration.new_sqlite_classes)) {
      lines.push(`      "new_sqlite_classes": ${JSON.stringify(migration.new_sqlite_classes)},`);
    }
    lines.push("    },");
  }
  lines.push("  ],");
}

function appendR2Buckets(lines, buckets) {
  const cleanBuckets = Array.isArray(buckets) ? buckets : [];
  lines.push('  "r2_buckets": [');
  for (const bucket of cleanBuckets) {
    lines.push(
      `    // # created by setup docs: run \`wrangler r2 bucket create ${String(
        bucket.bucket_name,
      )}\`.`,
    );
    lines.push(`    ${inlineObject(bucket)},`);
  }
  lines.push("  ],");
}

function appendKvNamespaces(lines, namespaces) {
  const cleanNamespaces = Array.isArray(namespaces) ? namespaces : [];
  lines.push('  "kv_namespaces": [');
  for (const namespace of cleanNamespaces) {
    const cleanNamespace = {
      binding: namespace.binding,
      id: "REPLACE_WITH_KV_ID",
    };
    lines.push(
      `    // # created by setup docs: run \`wrangler kv namespace create ${String(
        namespace.binding,
      )}\`.`,
    );
    lines.push(`    ${inlineObject(cleanNamespace)},`);
  }
  lines.push("  ],");
}

function appendD1Databases(lines, databases) {
  const cleanDatabases = Array.isArray(databases) ? databases : [];
  lines.push('  "d1_databases": [');
  for (const database of cleanDatabases) {
    lines.push(
      `    // # created by setup docs: run \`wrangler d1 create ${String(
        database.database_name,
      )}\`.`,
    );
    lines.push("    {");
    lines.push(`      "binding": ${JSON.stringify(database.binding)},`);
    lines.push(`      "database_name": ${JSON.stringify(database.database_name)},`);
    lines.push('      "database_id": "REPLACE_WITH_D1_ID",');
    lines.push(
      `      "migrations_dir": ${JSON.stringify(database.migrations_dir ?? "migrations")},`,
    );
    lines.push("    },");
  }
  lines.push("  ],");
}

function appendRateLimits(lines, ratelimits) {
  const cleanRateLimits = Array.isArray(ratelimits)
    ? ratelimits.filter((limit) => limit?.name !== "DEMO_API_RATE_LIMITER")
    : [];
  if (cleanRateLimits.length === 0) {
    return;
  }

  lines.push('  "ratelimits": [');
  for (const limit of cleanRateLimits) {
    lines.push(
      `    // # created by setup docs: ${String(limit.name)} protects public ingest before Durable Object writes.`,
    );
    lines.push("    {");
    lines.push(`      "name": ${JSON.stringify(limit.name)},`);
    lines.push(`      "namespace_id": ${JSON.stringify(limit.namespace_id)},`);
    lines.push(`      "simple": ${inlineObject(limit.simple ?? {})},`);
    lines.push("    },");
  }
  lines.push("  ],");
}

function appendQueues(lines, queues) {
  const producers = Array.isArray(queues?.producers) ? queues.producers : [];
  const consumers = Array.isArray(queues?.consumers) ? queues.consumers : [];

  lines.push('  "queues": {');
  lines.push('    "producers": [');
  for (const producer of producers) {
    lines.push(
      `      // # created by setup docs: run \`wrangler queues create ${String(producer.queue)}\`.`,
    );
    lines.push(`      ${inlineObject(producer)},`);
  }
  lines.push("    ],");
  lines.push('    "consumers": [');
  for (const consumer of consumers) {
    const deadLetter = consumer.dead_letter_queue;
    if (typeof deadLetter === "string" && deadLetter.length > 0) {
      lines.push(
        `      // # created by setup docs: run \`wrangler queues create ${deadLetter}\` for the dead-letter queue.`,
      );
    }
    lines.push("      {");
    const entries = Object.entries(consumer);
    for (const [key, value] of entries) {
      lines.push(`        ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    }
    lines.push("      },");
  }
  lines.push("    ],");
  lines.push("  },");
}

function appendTriggers(lines, triggers) {
  const crons = Array.isArray(triggers?.crons) ? triggers.crons : [];
  lines.push('  "triggers": {');
  lines.push(`    "crons": ${JSON.stringify(crons)},`);
  lines.push("  },");
}

function appendSecretNotes(lines) {
  lines.push("  // DEV_API_TOKEN is created with `wrangler secret put DEV_API_TOKEN`.");
  lines.push("  // DEV_API_PROJECT_IDS is created with `wrangler secret put DEV_API_PROJECT_IDS`.");
  lines.push("  // LIVE_TICKET_SECRET is created with `wrangler secret put LIVE_TICKET_SECRET`.");
  lines.push("  // Do not put secret values in this file.");
}

function buildTemplateReadme() {
  return `# Orange Replay self-host template

This directory is generated by \`node scripts/mirror-template.mjs\`. It mirrors the canonical combined Worker in \`apps/worker\` so the self-host package does not drift.

Follow \`../../docs/self-host.md\` for the setup steps. Do not edit generated files here by hand; change the canonical worker config or migrations, then run the mirror script again.

Deploy-button placeholder: button wiring lands when the public template repo is published.
`;
}

function appendObject(lines, key, value) {
  lines.push(`  ${JSON.stringify(key)}: {`);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    lines.push(`    ${JSON.stringify(entryKey)}: ${JSON.stringify(entryValue)},`);
  }
  lines.push("  },");
}

function parseJsonc(text, label) {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${label}: ${message}`);
  }
}

function stripJsonComments(text) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") {
          output += "\n";
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(text) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] ?? "")) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        continue;
      }
    }

    output += char;
  }

  return output;
}

async function compareDirectories(expectedDir, actualDir) {
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

function pushJsonProperty(lines, key, value, indentLevel, withComma = true) {
  const indent = "  ".repeat(indentLevel);
  const valueLines = formatJsonValue(value, indentLevel);
  lines.push(`${indent}${JSON.stringify(key)}: ${valueLines[0]}`);
  for (const line of valueLines.slice(1)) {
    lines.push(line);
  }
  if (withComma) {
    lines[lines.length - 1] += ",";
  }
}

function formatJsonValue(value, indentLevel) {
  const restIndent = "  ".repeat(indentLevel);
  const lines = JSON.stringify(value, null, 2).split("\n");
  return [lines[0], ...lines.slice(1).map((line) => `${restIndent}${line}`)];
}

function inlineObject(record) {
  const parts = Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{ ${parts.join(", ")} }`;
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === metaUrl;
}
