#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildSetupPlan,
  findArrayValue,
  findTextValue,
  loadAnalyticsResources,
  parseSetupArguments,
  readJsonCommandOutput,
  redactSecret,
} from "./analytics/setup-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(repoRoot, "infra", "analytics", "resources.production.json");
const helpText = `Usage: node scripts/setup-analytics.mjs [options]

Options:
  --config <file>  Resource config (default: infra/analytics/resources.production.json)
  --offline        Show the complete plan without reading Cloudflare
  --apply          Create missing resources. Without this flag, nothing changes.
  --help           Show this help

--apply needs ORANGE_REPLAY_CATALOG_TOKEN for sinks and catalog maintenance.
The token is never printed.`;

try {
  const options = parseSetupArguments(process.argv.slice(2), defaultConfigPath);
  if (options.help) {
    console.log(helpText);
    process.exit(0);
  }

  const resources = await loadAnalyticsResources(options.configPath);
  const currentState = options.offline ? emptyState(resources) : inspectResources(resources);
  const plan = buildSetupPlan(resources, currentState);

  if (!options.apply) {
    console.log(
      JSON.stringify(
        {
          event: "analytics.setup",
          mode: options.offline ? "offline_dry_run" : "dry_run",
          needsCatalogToken: plan.needsCatalogToken,
          steps: plan.steps,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const catalogToken = readCatalogToken(plan.needsCatalogToken);
  const applied = applyPlan(resources, currentState, catalogToken);
  console.log(
    JSON.stringify(
      {
        event: "analytics.setup",
        mode: "apply",
        steps: applied.steps,
        streamId: applied.streamId,
        warehouse: applied.warehouse,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const token = process.env.ORANGE_REPLAY_CATALOG_TOKEN ?? "";
  console.error(redactSecret(error instanceof Error ? error.message : String(error), [token]));
  process.exit(1);
}

function inspectResources(resources) {
  const bucket = lookupExists(
    ["r2", "bucket", "info", resources.bucket, "--json"],
    "Analytics bucket",
  );
  const catalog = bucket
    ? lookupExists(["r2", "bucket", "catalog", "get", resources.bucket], "Analytics Data Catalog")
    : false;
  const streamResult = getJsonResource(
    ["pipelines", "streams", "get", resources.stream, "--json"],
    "Pipeline stream lookup",
  );
  const sinkResults = Object.fromEntries(
    resources.sinks.map((sink) => [
      sink.name,
      getJsonResource(
        ["pipelines", "sinks", "get", sink.name, "--json"],
        `Pipeline sink ${sink.name} lookup`,
      ),
    ]),
  );
  const pipelineList = getJsonResource(["pipelines", "list", "--json"], "Pipeline list");
  const pipelineSummary = findNamedResource(pipelineList.value, resources.pipeline);
  const pipelineResult =
    pipelineSummary === undefined
      ? { exists: false, value: undefined }
      : getJsonResource(
          [
            "pipelines",
            "get",
            typeof pipelineSummary.id === "string" ? pipelineSummary.id : resources.pipeline,
            "--json",
          ],
          "Pipeline lookup",
        );

  const currentState = {
    bucket,
    catalog,
    pipeline: pipelineResult.exists,
    pipelineDetails: pipelineResult.value,
    sinks: Object.fromEntries(
      Object.entries(sinkResults).map(([name, result]) => [name, result.exists]),
    ),
    sinkDetails: Object.fromEntries(
      Object.entries(sinkResults).map(([name, result]) => [name, result.value]),
    ),
    stream: streamResult.exists,
    streamDetails: streamResult.value,
  };
  validateExistingResources(resources, currentState);
  return currentState;
}

function applyPlan(resources, currentState, catalogToken) {
  const steps = [];
  let warehouse;
  let streamId = findTextValue(currentState.streamDetails, new Set(["id", "stream_id"]));

  if (!currentState.bucket) {
    runWrangler(["r2", "bucket", "create", resources.bucket]);
    steps.push({ action: "created", kind: "bucket", name: resources.bucket });
  } else {
    steps.push({ action: "kept", kind: "bucket", name: resources.bucket });
  }

  if (!currentState.catalog) {
    const result = runWrangler(["r2", "bucket", "catalog", "enable", resources.bucket]);
    warehouse = readNamedLine(result.stdout, ["warehouse name", "warehouse"]);
    steps.push({ action: "created", kind: "catalog", name: resources.bucket });
  } else {
    const result = runWrangler(["r2", "bucket", "catalog", "get", resources.bucket]);
    warehouse = readNamedLine(result.stdout, ["warehouse name", "warehouse"]);
    steps.push({ action: "kept", kind: "catalog", name: resources.bucket });
  }

  if (!currentState.stream) {
    runWrangler([
      "pipelines",
      "streams",
      "create",
      resources.stream,
      "--schema-file",
      resources.schemaFile,
      "--http-enabled=false",
    ]);
    const streamResult = getJsonResource(
      ["pipelines", "streams", "get", resources.stream, "--json"],
      "Created Pipeline stream lookup",
    );
    streamId = findTextValue(streamResult.value, new Set(["id", "stream_id"]));
    steps.push({ action: "created", kind: "stream", name: resources.stream });
  } else {
    steps.push({ action: "kept", kind: "stream", name: resources.stream });
  }

  for (const sink of resources.sinks) {
    if (!currentState.sinks[sink.name]) {
      runWrangler([
        "pipelines",
        "sinks",
        "create",
        sink.name,
        "--type",
        "r2-data-catalog",
        "--bucket",
        resources.bucket,
        "--namespace",
        resources.namespace,
        "--table",
        sink.table,
        "--catalog-token",
        catalogToken,
        "--compression",
        resources.compression,
        "--roll-interval",
        String(resources.rollIntervalSeconds),
      ]);
      steps.push({ action: "created", kind: "sink", name: sink.name, table: sink.table });
    } else {
      steps.push({ action: "kept", kind: "sink", name: sink.name, table: sink.table });
    }
  }

  runWrangler([
    "r2",
    "bucket",
    "catalog",
    "compaction",
    "enable",
    resources.bucket,
    "--target-size",
    String(resources.maintenance.compactionTargetMb),
    "--token",
    catalogToken,
  ]);
  steps.push({
    action: "configured",
    kind: "catalog_compaction",
    name: resources.bucket,
    targetSizeMb: resources.maintenance.compactionTargetMb,
  });

  runWrangler([
    "r2",
    "bucket",
    "catalog",
    "snapshot-expiration",
    "enable",
    resources.bucket,
    "--older-than-days",
    String(resources.maintenance.snapshotOlderThanDays),
    "--retain-last",
    String(resources.maintenance.snapshotRetainLast),
    "--token",
    catalogToken,
  ]);
  steps.push({
    action: "configured",
    kind: "catalog_snapshot_expiration",
    name: resources.bucket,
    olderThanDays: resources.maintenance.snapshotOlderThanDays,
    retainLast: resources.maintenance.snapshotRetainLast,
  });

  if (!currentState.pipeline) {
    runWrangler([
      "pipelines",
      "create",
      resources.pipeline,
      "--sql-file",
      resources.pipelineSqlFile,
    ]);
    steps.push({ action: "created", kind: "pipeline", name: resources.pipeline });
  } else {
    steps.push({ action: "kept", kind: "pipeline", name: resources.pipeline });
  }

  if (streamId === undefined) {
    throw new Error(
      "Analytics resources are present, but Wrangler did not return the stream id. Run the read-only stream get command and do not deploy the binding until the id is verified.",
    );
  }
  if (warehouse === undefined) {
    throw new Error(
      "Analytics resources are present, but Wrangler did not return the warehouse name. Run the read-only catalog get command and do not enable R2 SQL until the name is verified.",
    );
  }
  return { steps, streamId, warehouse };
}

function getJsonResource(args, label) {
  const result = runWrangler(args, { allowFailure: true });
  if (!result.ok) {
    if (looksMissing(result)) return { exists: false, value: undefined };
    throw new Error(`${label} failed: ${cleanFailure(result)}`);
  }
  return { exists: true, value: readJsonCommandOutput(result.stdout, label) };
}

function lookupExists(args, label) {
  const result = runWrangler(args, { allowFailure: true });
  if (result.ok) {
    const output = `${result.stdout}\n${result.stderr}`;
    return !/\b(?:disabled|not enabled)\b/i.test(output);
  }
  if (looksMissing(result)) return false;
  throw new Error(`${label} lookup failed: ${cleanFailure(result)}`);
}

function runWrangler(args, options = {}) {
  const result = spawnSync(
    "vp",
    ["exec", "--filter", "@orange-replay/worker", "--", "wrangler", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_LOG_SANITIZE: "true",
        WRANGLER_WRITE_LOGS: "false",
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const catalogToken = process.env.ORANGE_REPLAY_CATALOG_TOKEN ?? "";
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const message = redactSecret(result.stderr || result.stdout || "Wrangler command failed.", [
      catalogToken,
    ]).trim();
    throw new Error(message || "Wrangler command failed.");
  }
  return {
    ok: result.status === 0,
    stderr: redactSecret(result.stderr ?? "", [catalogToken]),
    stdout: redactSecret(result.stdout ?? "", [catalogToken]),
  };
}

function readCatalogToken(required) {
  const token = process.env.ORANGE_REPLAY_CATALOG_TOKEN?.trim() ?? "";
  if (required && token.length < 20) {
    throw new Error("ORANGE_REPLAY_CATALOG_TOKEN is required to create a Data Catalog sink.");
  }
  return token;
}

function looksMissing(result) {
  return /\b(?:not found|does not exist|could not find|no .+ found|not enabled)\b/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

function cleanFailure(result) {
  return (result.stderr || result.stdout || "Wrangler command failed.").trim();
}

function findNamedResource(value, name) {
  if (!Array.isArray(value)) return undefined;
  return value.find((item) => {
    return (
      item !== null &&
      typeof item === "object" &&
      (item.name === name || item.pipeline_name === name)
    );
  });
}

function validateExistingResources(resources, currentState) {
  const remoteFields = findArrayValue(currentState.streamDetails, new Set(["fields"]));
  if (
    remoteFields !== undefined &&
    JSON.stringify(normalizeFields(remoteFields)) !==
      JSON.stringify(normalizeFields(resources.streamSchema.fields))
  ) {
    throw new Error(
      "The existing analytics stream schema differs from infra/analytics/stream-schema.json. Stop and review it; stream schemas cannot be changed in place.",
    );
  }

  for (const sink of resources.sinks) {
    const details = currentState.sinkDetails[sink.name];
    if (details === undefined) continue;
    requireMatchingValue(details, new Set(["bucket"]), resources.bucket, `${sink.name} bucket`);
    requireMatchingValue(
      details,
      new Set(["namespace"]),
      resources.namespace,
      `${sink.name} namespace`,
    );
    requireMatchingValue(
      details,
      new Set(["table", "table_name"]),
      sink.table,
      `${sink.name} table`,
    );
  }

  const remoteSql = findTextValue(currentState.pipelineDetails, new Set(["sql"]));
  if (remoteSql !== undefined && normalizeSql(remoteSql) !== normalizeSql(resources.pipelineSql)) {
    throw new Error(
      "The existing analytics Pipeline SQL differs from infra/analytics/pipeline.sql. Stop and review it; setup will not replace it.",
    );
  }
}

function requireMatchingValue(details, names, expected, label) {
  const actual = findTextValue(details, names);
  if (actual !== undefined && actual !== expected) {
    throw new Error(`Existing ${label} is ${actual}, expected ${expected}. Setup stopped.`);
  }
}

function normalizeSql(sql) {
  return sql.replaceAll(/\s+/g, " ").trim();
}

function normalizeFields(fields) {
  return fields
    .map((field) => ({
      name: field?.name,
      required: field?.required === true,
      type: field?.type,
      unit: field?.unit,
    }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function readNamedLine(output, labels) {
  for (const line of output.split(/\r?\n/)) {
    const plainLine = stripVTControlCharacters(line).trim();
    for (const label of labels) {
      const match = new RegExp(`${escapePattern(label)}\\s*[:=]\\s*(\\S+)`, "i").exec(plainLine);
      if (match?.[1] !== undefined) return match[1];
    }
  }
  return undefined;
}

function escapePattern(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptyState(resources) {
  return {
    bucket: false,
    catalog: false,
    pipeline: false,
    sinks: Object.fromEntries(resources.sinks.map((sink) => [sink.name, false])),
    stream: false,
  };
}
