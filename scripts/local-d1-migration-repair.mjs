const canonicalHistory = [
  "0011_hosted_auth.sql",
  "0012_key_cache_sync.sql",
  "0013_key_cache_final_check.sql",
  "0014_key_cache_write_jobs.sql",
  "0015_public_pages.sql",
];

const oldHistory = [
  "0009_hosted_auth.sql",
  "0010_key_cache_sync.sql",
  "0011_key_cache_final_check.sql",
  "0012_key_cache_write_jobs.sql",
];

const laterHistory = [
  "0010_hosted_auth.sql",
  "0011_key_cache_sync.sql",
  "0012_key_cache_final_check.sql",
  "0013_key_cache_write_jobs.sql",
  "0014_public_pages.sql",
];

const migrationSchema = {
  "0011_hosted_auth.sql": {
    tables: [
      "users",
      "auth_sessions",
      "auth_accounts",
      "auth_verifications",
      "auth_rate_limits",
      "members",
      "invitations",
    ],
    columns: {
      users: [
        "id",
        "name",
        "email",
        "email_verified",
        "image",
        "created_at",
        "updated_at",
        "role",
        "banned",
        "ban_reason",
        "ban_expires",
      ],
      auth_sessions: [
        "id",
        "expires_at",
        "token",
        "created_at",
        "updated_at",
        "ip_address",
        "user_agent",
        "user_id",
        "active_org_id",
        "impersonated_by",
      ],
      auth_accounts: [
        "id",
        "account_id",
        "provider_id",
        "user_id",
        "access_token",
        "refresh_token",
        "id_token",
        "access_token_expires_at",
        "refresh_token_expires_at",
        "scope",
        "password",
        "created_at",
        "updated_at",
      ],
      auth_verifications: ["id", "identifier", "value", "expires_at", "created_at", "updated_at"],
      auth_rate_limits: ["id", "key", "count", "last_request"],
      orgs: ["id", "name", "slug", "logo", "metadata", "shard", "created_at"],
      members: ["id", "org_id", "user_id", "role", "created_at"],
      invitations: [
        "id",
        "org_id",
        "email",
        "role",
        "status",
        "expires_at",
        "created_at",
        "inviter_id",
      ],
      keys: [
        "key_hash",
        "id",
        "project_id",
        "name",
        "active",
        "created_by",
        "created_at",
        "revoked_at",
        "revoked_by",
      ],
    },
    indexes: [
      "idx_users_email",
      "idx_users_created_at",
      "idx_auth_sessions_token",
      "idx_auth_sessions_user_id",
      "idx_auth_sessions_expires_at",
      "idx_auth_accounts_provider_account",
      "idx_auth_accounts_user_id",
      "idx_auth_verifications_identifier",
      "idx_auth_rate_limits_key",
      "idx_orgs_slug",
      "idx_members_org_user",
      "idx_members_user_id",
      "idx_members_org_id",
      "idx_invitations_org_id",
      "idx_invitations_email",
      "idx_keys_id",
      "idx_keys_project_active",
      "idx_projects_org_id",
    ],
  },
  "0012_key_cache_sync.sql": {
    columns: { keys: ["cache_synced"] },
    indexes: ["idx_keys_cache_sync"],
  },
  "0013_key_cache_final_check.sql": {
    columns: { keys: ["cache_final_check_at"] },
    indexes: ["idx_keys_cache_final_check"],
  },
  "0014_key_cache_write_jobs.sql": {
    tables: ["key_cache_writes"],
    columns: { key_cache_writes: ["id", "key_hash", "started_at"] },
    indexes: ["idx_key_cache_writes_hash"],
  },
  "0015_public_pages.sql": {
    tables: ["project_public_pages", "public_page_sessions"],
    columns: {
      project_public_pages: [
        "project_id",
        "public_id",
        "is_enabled",
        "revision",
        "published_at",
        "updated_at",
      ],
      public_page_sessions: [
        "project_id",
        "session_id",
        "public_replay_id",
        "position",
        "added_at",
      ],
    },
    indexes: [
      "idx_project_public_pages_public_id",
      "idx_project_public_pages_enabled",
      "idx_public_page_sessions_replay_id",
      "idx_public_page_sessions_position",
    ],
  },
};

export const analyticsMigrationName = "0009_analytics_warehouse.sql";

export const analyticsBaseSchemaKeys = schemaKeys({
  tables: [
    "analytics_export_outbox",
    "analytics_export_ledger",
    "analytics_warehouse_state",
    "analytics_export_lease",
    "analytics_deletion_jobs",
    "analytics_backfill_completions",
  ],
  indexes: [
    "idx_analytics_export_outbox_pending",
    "idx_analytics_export_outbox_project_sequence",
    "idx_analytics_export_outbox_session_sequence",
    "idx_analytics_export_ledger_session_sequence",
    "idx_analytics_deletion_jobs_pending",
  ],
});

export const oldAnalyticsDeletionJobColumnShapes = [
  columnShape("project_id", "TEXT", 1, null, 1),
  columnShape("session_id", "TEXT", 1, null, 2),
  columnShape("requested_at", "INTEGER", 1),
  columnShape("delete_reason", "TEXT", 1),
  columnShape("deletion_export_sequence", "INTEGER"),
  columnShape("purge_attempts", "INTEGER", 1, "0"),
  columnShape("purge_last_attempt_at", "INTEGER"),
  columnShape("purge_last_error", "TEXT"),
  columnShape("first_zero_at", "INTEGER"),
  columnShape("completed_at", "INTEGER"),
  columnShape("lease_owner", "TEXT"),
  columnShape("lease_expires_at", "INTEGER"),
  columnShape("alerted_at", "INTEGER"),
];

const analyticsTombstoneColumnShape = columnShape(
  "requires_warehouse_tombstone",
  "INTEGER",
  1,
  "1",
);

export const oldAnalyticsDeletionJobSql = `
CREATE TABLE analytics_deletion_jobs (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL CHECK (requested_at > 0),
  delete_reason TEXT NOT NULL CHECK (length(delete_reason) BETWEEN 1 AND 200),
  deletion_export_sequence INTEGER CHECK (deletion_export_sequence > 0),
  purge_attempts INTEGER NOT NULL DEFAULT 0 CHECK (purge_attempts >= 0),
  purge_last_attempt_at INTEGER,
  purge_last_error TEXT,
  first_zero_at INTEGER,
  completed_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  alerted_at INTEGER,
  PRIMARY KEY (project_id, session_id)
)
`;

export const canonicalAnalyticsDeletionJobSql = `
CREATE TABLE analytics_deletion_jobs (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL CHECK (requested_at > 0),
  delete_reason TEXT NOT NULL CHECK (length(delete_reason) BETWEEN 1 AND 200),
  requires_warehouse_tombstone INTEGER NOT NULL DEFAULT 1
    CHECK (requires_warehouse_tombstone IN (0, 1)),
  deletion_export_sequence INTEGER CHECK (deletion_export_sequence > 0),
  purge_attempts INTEGER NOT NULL DEFAULT 0 CHECK (purge_attempts >= 0),
  purge_last_attempt_at INTEGER,
  purge_last_error TEXT,
  first_zero_at INTEGER,
  completed_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  alerted_at INTEGER,
  PRIMARY KEY (project_id, session_id)
)
`;

export const repairedAnalyticsDeletionJobSql = `
CREATE TABLE analytics_deletion_jobs (
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL CHECK (requested_at > 0),
  delete_reason TEXT NOT NULL CHECK (length(delete_reason) BETWEEN 1 AND 200),
  deletion_export_sequence INTEGER CHECK (deletion_export_sequence > 0),
  purge_attempts INTEGER NOT NULL DEFAULT 0 CHECK (purge_attempts >= 0),
  purge_last_attempt_at INTEGER,
  purge_last_error TEXT,
  first_zero_at INTEGER,
  completed_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  alerted_at INTEGER, requires_warehouse_tombstone INTEGER NOT NULL DEFAULT 1
      CHECK (requires_warehouse_tombstone IN (0, 1)),
  PRIMARY KEY (project_id, session_id)
)
`;

export function shouldRepairLocalMigrationHistory(options) {
  const local = optionIsEnabled(options, "--local");
  const remote = optionIsEnabled(options, "--remote") || optionIsEnabled(options, "--preview");
  if (local && remote) {
    throw repairError("--local cannot be combined with --remote or --preview.");
  }
  return local;
}

export function planKnownMigrationHistoryRepair(appliedNames) {
  const applied = new Set(appliedNames);
  const oldFound = oldHistory.some((name) => applied.has(name));
  const laterFound = laterHistory.some((name) => applied.has(name));
  const canonicalFound = canonicalHistory.some((name) => applied.has(name));

  if (!oldFound && !laterFound) return null;
  if (oldFound && laterFound) {
    throw repairError("the database contains a mix of both known renamed histories.");
  }
  if (canonicalFound) {
    throw repairError("the database contains both legacy and canonical migration names.");
  }

  const historyName = oldFound ? "old 0009-0012" : "later 0010-0014";
  const history = oldFound ? oldHistory : laterHistory;
  const present = history.map((name) => applied.has(name));
  const lastAppliedIndex = present.lastIndexOf(true);
  for (let index = 0; index <= lastAppliedIndex; index += 1) {
    if (!present[index]) {
      throw repairError(`${historyName} history has a gap before ${history[lastAppliedIndex]}.`);
    }
  }

  return {
    historyName,
    mappings: history.slice(0, lastAppliedIndex + 1).map((from, index) => ({
      from,
      to: canonicalHistory[index],
    })),
  };
}

export function requiredSchemaKeys(canonicalNames) {
  return canonicalNames.flatMap((name) => {
    const requirement = migrationSchema[name];
    if (requirement === undefined) throw repairError(`no schema check exists for ${name}.`);
    return schemaKeys(requirement);
  });
}

export function requiredSchemaObjectNames(canonicalNames) {
  const names = new Set();
  for (const canonicalName of canonicalNames) {
    const requirement = migrationSchema[canonicalName];
    if (requirement === undefined)
      throw repairError(`no schema check exists for ${canonicalName}.`);
    for (const table of requirement.tables ?? []) names.add(table);
    for (const table of Object.keys(requirement.columns ?? {})) names.add(table);
    for (const index of requirement.indexes ?? []) names.add(index);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function schemaObjectDifferences(expectedRows, actualRows) {
  const expected = schemaObjectMap(expectedRows);
  const actual = schemaObjectMap(actualRows);
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  const differences = [];
  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    if (!actual.has(key)) {
      differences.push(`${key} is missing`);
    } else if (!expected.has(key)) {
      differences.push(`${key} is unexpected`);
    } else if (expected.get(key) !== actual.get(key)) {
      differences.push(`${key} has a different definition`);
    }
  }
  return differences;
}

export function missingSchemaKeys(required, actual) {
  const actualSet = new Set(actual);
  return [...new Set(required)]
    .filter((key) => !actualSet.has(key))
    .sort((left, right) => left.localeCompare(right));
}

export function buildHistoryRepairSql(mappings) {
  if (mappings.length === 0) throw repairError("no migration names were provided to repair.");
  const cases = mappings.map(({ from, to }) => `WHEN ${sqlText(from)} THEN ${sqlText(to)}`);
  const sources = mappings.map(({ from }) => sqlText(from));
  return `UPDATE d1_migrations\nSET name = CASE name\n  ${cases.join("\n  ")}\n  ELSE name\nEND\nWHERE name IN (${sources.join(", ")})`;
}

export function planAnalyticsDeletionJobRepair({
  migrationApplied,
  baseSchemaMissing,
  columns,
  tableSql,
}) {
  if (!migrationApplied) return "none";
  if (baseSchemaMissing.length > 0) {
    throw repairError(`analytics migration 0009 is missing ${baseSchemaMissing.join(", ")}.`);
  }

  const tombstoneColumn = columns.find((column) => column.name === "requires_warehouse_tombstone");
  const normalizedTableSql = normalizeSchemaSql(tableSql);
  if (tombstoneColumn !== undefined) {
    if (!columnShapesMatch([analyticsTombstoneColumnShape], [tombstoneColumn])) {
      throw repairError("analytics migration 0009 has an unexpected deletion-job column shape.");
    }
    const expectedTombstoneDefinition = normalizeSchemaSql(`
      requires_warehouse_tombstone INTEGER NOT NULL DEFAULT 1
        CHECK (requires_warehouse_tombstone IN (0, 1))
    `);
    if (!normalizedTableSql.includes(expectedTombstoneDefinition)) {
      throw repairError("analytics migration 0009 has an unexpected deletion-job definition.");
    }
    return "none";
  }

  if (!columnShapesMatch(oldAnalyticsDeletionJobColumnShapes, columns)) {
    throw repairError("analytics migration 0009 has an unexpected deletion-job column shape.");
  }
  if (normalizedTableSql !== normalizeSchemaSql(oldAnalyticsDeletionJobSql)) {
    throw repairError("analytics migration 0009 has an unexpected older deletion-job definition.");
  }
  return "add_tombstone_column";
}

function schemaObjectMap(rows) {
  const result = new Map();
  for (const row of rows) {
    if (
      (row.type !== "table" && row.type !== "index") ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw repairError("a schema definition could not be read safely.");
    }
    const key = `${row.type}:${row.name}`;
    if (result.has(key)) throw repairError(`the schema contains duplicate ${key} definitions.`);
    result.set(key, normalizeSchemaSql(row.sql));
  }
  return result;
}

function normalizeSchemaSql(sql) {
  return typeof sql === "string" ? sql.trim().replace(/\s+/gu, " ") : "";
}

function columnShape(name, type, notNull = 0, defaultValue = null, primaryKey = 0) {
  return { name, type, notNull, defaultValue, primaryKey };
}

function columnShapesMatch(expected, actual) {
  if (expected.length !== actual.length) return false;
  const actualByName = new Map(actual.map((column) => [column.name, column]));
  return expected.every((column) => {
    const found = actualByName.get(column.name);
    return (
      found !== undefined &&
      String(found.type).toUpperCase() === column.type &&
      Number(found.notNull) === column.notNull &&
      normalizeDefault(found.defaultValue) === normalizeDefault(column.defaultValue) &&
      Number(found.primaryKey) === column.primaryKey
    );
  });
}

function schemaKeys(requirement) {
  const keys = [
    ...(requirement.tables ?? []).map((name) => `table:${name}`),
    ...(requirement.indexes ?? []).map((name) => `index:${name}`),
  ];
  for (const [table, columns] of Object.entries(requirement.columns ?? {})) {
    keys.push(...columns.map((name) => `column:${table}:${name}`));
  }
  return keys;
}

function optionIsEnabled(options, name) {
  return options.some((option) => option === name || option === `${name}=true`);
}

function normalizeDefault(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\((.*)\)$/u, "$1")
    .replace(/^['"]|['"]$/gu, "");
}

function sqlText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function repairError(message) {
  return new Error(`Local D1 migration repair stopped: ${message}`);
}
