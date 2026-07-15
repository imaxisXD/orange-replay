import { readFile } from "node:fs/promises";
import path from "node:path";

const safeNamePattern = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const safePipelineNamePattern = /^[a-z0-9][a-z0-9_]{1,62}$/;
const allowedCompression = new Set(["zstd", "snappy", "gzip", "lz4", "uncompressed"]);

export async function loadAnalyticsResources(configPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read analytics resource config at ${configPath}.`, { cause: error });
  }

  const configDirectory = path.dirname(configPath);
  const resources = {
    bucket: requireName(parsed.bucket, "bucket"),
    namespace: requireName(parsed.namespace, "namespace"),
    stream: requireName(parsed.stream, "stream"),
    pipeline: requirePipelineName(parsed.pipeline),
    schemaFile: resolveFile(configDirectory, parsed.schemaFile, "schemaFile"),
    pipelineSqlFile: resolveFile(configDirectory, parsed.pipelineSqlFile, "pipelineSqlFile"),
    rollIntervalSeconds: requireSafeInteger(
      parsed.rollIntervalSeconds,
      "rollIntervalSeconds",
      60,
      86_400,
    ),
    compression: requireCompression(parsed.compression),
    maintenance: requireMaintenance(parsed.maintenance),
    sinks: requireSinks(parsed.sinks),
  };

  let streamSchema;
  let pipelineSql;
  try {
    streamSchema = JSON.parse(await readFile(resources.schemaFile, "utf8"));
    pipelineSql = await readFile(resources.pipelineSqlFile, "utf8");
  } catch (error) {
    throw new Error("Could not read the analytics stream schema or Pipeline SQL.", {
      cause: error,
    });
  }
  validateStreamSchema(streamSchema);
  validatePipelineSql(pipelineSql, resources);
  resources.streamSchema = streamSchema;
  resources.pipelineSql = pipelineSql;

  if (new Set(resources.sinks.map((sink) => sink.name)).size !== resources.sinks.length) {
    throw new Error("Analytics sink names must be unique.");
  }
  if (new Set(resources.sinks.map((sink) => sink.table)).size !== resources.sinks.length) {
    throw new Error("Analytics table names must be unique.");
  }

  return resources;
}

export function buildSetupPlan(resources, currentState) {
  const steps = [
    setupStep("bucket", resources.bucket, currentState.bucket),
    setupStep("catalog", resources.bucket, currentState.catalog),
    setupStep("stream", resources.stream, currentState.stream),
    ...resources.sinks.map((sink) => setupStep("sink", sink.name, currentState.sinks[sink.name])),
    setupStep("pipeline", resources.pipeline, currentState.pipeline),
    {
      action: "configure",
      kind: "catalog_compaction",
      name: resources.bucket,
      targetSizeMb: resources.maintenance.compactionTargetMb,
    },
    {
      action: "configure",
      kind: "catalog_snapshot_expiration",
      name: resources.bucket,
      olderThanDays: resources.maintenance.snapshotOlderThanDays,
      retainLast: resources.maintenance.snapshotRetainLast,
    },
  ];

  return {
    steps,
    // Catalog maintenance always needs the bucket-scoped credential.
    needsCatalogToken: true,
    // Cloudflare currently rejects bucket-scoped credentials when it creates
    // a Pipeline Data Catalog sink. Read the broader credential only when a
    // sink is missing.
    needsPipelineCatalogToken: resources.sinks.some((sink) => !currentState.sinks[sink.name]),
  };
}

export function readSetupTokens(environment, plan) {
  const catalogToken = environment.ORANGE_REPLAY_CATALOG_TOKEN?.trim() ?? "";
  const pipelineCatalogToken = environment.ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN?.trim() ?? "";

  if (plan.needsCatalogToken && catalogToken.length < 20) {
    throw new Error("ORANGE_REPLAY_CATALOG_TOKEN is required for Data Catalog maintenance.");
  }
  if (plan.needsPipelineCatalogToken && pipelineCatalogToken.length < 20) {
    throw new Error(
      "ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN is required to create a Data Catalog Pipeline sink.",
    );
  }
  if (
    plan.needsPipelineCatalogToken &&
    catalogToken.length > 0 &&
    catalogToken === pipelineCatalogToken
  ) {
    throw new Error("Use different tokens for Pipeline sink creation and bucket maintenance.");
  }

  return { catalogToken, pipelineCatalogToken };
}

export function environmentWithoutSetupTokens(environment) {
  const childEnvironment = { ...environment };
  delete childEnvironment.ORANGE_REPLAY_CATALOG_TOKEN;
  delete childEnvironment.ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN;
  return childEnvironment;
}

export function parseSetupArguments(argumentsList, defaultConfigPath) {
  const options = {
    apply: false,
    configPath: defaultConfigPath,
    offline: false,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--offline") {
      options.offline = true;
      continue;
    }
    if (argument === "--config") {
      const value = argumentsList[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--config needs a file path.");
      }
      options.configPath = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown setup option: ${argument}`);
  }

  if (options.apply && options.offline) {
    throw new Error("--apply cannot be combined with --offline.");
  }

  return options;
}

export function redactSecret(text, secrets) {
  let redacted = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      redacted = redacted.replaceAll(secret, "[hidden]");
    }
  }
  return redacted;
}

export function readJsonCommandOutput(output, label) {
  const trimmed = output.trim();
  const jsonStart = Math.min(...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((i) => i >= 0));
  if (!Number.isFinite(jsonStart)) {
    throw new Error(`${label} returned an unreadable response.`);
  }
  try {
    return JSON.parse(trimmed.slice(jsonStart));
  } catch (error) {
    throw new Error(`${label} returned an unreadable response.`, { cause: error });
  }
}

export function findTextValue(value, wantedNames) {
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (wantedNames.has(key) && typeof child === "string") return child;
    const nested = findTextValue(child, wantedNames);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function findArrayValue(value, wantedNames) {
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (wantedNames.has(key) && Array.isArray(child)) return child;
    const nested = findArrayValue(child, wantedNames);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function setupStep(kind, name, exists) {
  return { action: exists ? "keep" : "create", kind, name };
}

function requireName(value, label) {
  if (typeof value !== "string" || !safeNamePattern.test(value)) {
    throw new Error(`${label} must use only lower-case letters, numbers, hyphens, or underscores.`);
  }
  return value;
}

function requirePipelineName(value) {
  if (typeof value !== "string" || !safePipelineNamePattern.test(value)) {
    throw new Error("pipeline must use only lower-case letters, numbers, or underscores.");
  }
  return value;
}

function requireSinks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new Error("Analytics config must define between one and three sinks.");
  }
  return value.map((sink, index) => {
    if (sink === null || typeof sink !== "object") {
      throw new Error(`sinks[${index}] must be an object.`);
    }
    return {
      name: requireName(sink.name, `sinks[${index}].name`),
      table: requireName(sink.table, `sinks[${index}].table`),
    };
  });
}

function resolveFile(directory, value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a file path.`);
  }
  return path.resolve(directory, value);
}

function requireSafeInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function requireCompression(value) {
  if (typeof value !== "string" || !allowedCompression.has(value)) {
    throw new Error("compression must be zstd, snappy, gzip, lz4, or uncompressed.");
  }
  return value;
}

function requireMaintenance(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("maintenance must be an object.");
  }
  const target = requireSafeInteger(value.compactionTargetMb, "compactionTargetMb", 64, 512);
  if (![64, 128, 256, 512].includes(target)) {
    throw new Error("compactionTargetMb must be 64, 128, 256, or 512.");
  }
  return {
    compactionTargetMb: target,
    snapshotOlderThanDays: requireSafeInteger(
      value.snapshotOlderThanDays,
      "snapshotOlderThanDays",
      1,
      365,
    ),
    snapshotRetainLast: requireSafeInteger(
      value.snapshotRetainLast,
      "snapshotRetainLast",
      1,
      10_000,
    ),
  };
}

function validateStreamSchema(schema) {
  if (schema === null || typeof schema !== "object" || !Array.isArray(schema.fields)) {
    throw new Error("Analytics stream schema needs a fields array.");
  }
  const fieldNames = schema.fields.map((field) => field?.name);
  if (
    fieldNames.some((name) => typeof name !== "string") ||
    new Set(fieldNames).size !== fieldNames.length
  ) {
    throw new Error("Analytics stream field names must be present and unique.");
  }
  const requiredCommonFields = [
    "schema_version",
    "record_kind",
    "export_id",
    "export_sequence",
    "project_id",
    "session_id",
    "recorded_at",
  ];
  for (const name of requiredCommonFields) {
    const field = schema.fields.find((candidate) => candidate.name === name);
    if (field?.required !== true) {
      throw new Error(`Analytics stream field ${name} must be required.`);
    }
  }
}

function validatePipelineSql(sql, resources) {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new Error("Analytics Pipeline SQL cannot be empty.");
  }
  for (const sink of resources.sinks) {
    if (!sql.includes(`INSERT INTO ${sink.name}`)) {
      throw new Error(`Analytics Pipeline SQL does not write to ${sink.name}.`);
    }
  }
  const streamReads = sql.match(new RegExp(`FROM ${resources.stream}\\b`, "g"))?.length ?? 0;
  if (streamReads !== resources.sinks.length) {
    throw new Error("Every analytics sink must read from the configured stream exactly once.");
  }
}
