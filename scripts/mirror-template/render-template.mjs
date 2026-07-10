import { workerDir } from "./paths.mjs";

export function buildTemplateWrangler(source) {
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

export function buildTemplateReadme() {
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
