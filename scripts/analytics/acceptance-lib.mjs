import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGE_SIZE = 5_000;
const MAX_EXPORT_ID_PAGE_SIZE = 90;
const pathIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const resourceNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;
const forbiddenSqlPattern =
  /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|CREATE|ALTER|DROP|TRUNCATE|REPLACE|CALL|COPY|ATTACH|DETACH|INSTALL|LOAD|VACUUM)\b/i;
const comparedSessionColumns = [
  "org_id",
  "started_at",
  "ended_at",
  "duration_ms",
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
  "entry_url",
  "url_count",
  "page_count",
  "analytics_version",
  "max_scroll_depth",
  "quick_backs",
  "interaction_time_ms",
  "activity_hist",
  "clicks",
  "errors",
  "rages",
  "navs",
  "bytes",
  "segment_count",
  "flags",
  "manifest_key",
  "expires_at",
];
const normalizedSessionValueFields = [
  "activityHist",
  "analyticsVersion",
  "browser",
  "bytes",
  "city",
  "clicks",
  "country",
  "device",
  "durationMs",
  "endedAt",
  "entryUrl",
  "errors",
  "expiresAt",
  "flags",
  "hasSessionExport",
  "highestSequence",
  "interactionTimeMs",
  "manifestKey",
  "maxScrollDepth",
  "navs",
  "orgId",
  "os",
  "pageCount",
  "quickBacks",
  "rages",
  "region",
  "segmentCount",
  "sparseEventCount",
  "startedAt",
  "urlCount",
];

export function parseAcceptanceArguments(argumentsList, defaults = {}) {
  const options = {
    accountId: undefined,
    bucket: undefined,
    configPath: undefined,
    database: undefined,
    help: false,
    offline: false,
    pageSize: DEFAULT_PAGE_SIZE,
    projectIds: [],
    reportPath: undefined,
    warehouse: undefined,
    wranglerEnvironment: undefined,
    ...defaults,
  };
  const valueOptions = new Map([
    ["--account-id", "accountId"],
    ["--bucket", "bucket"],
    ["--config", "configPath"],
    ["--database", "database"],
    ["--env", "wranglerEnvironment"],
    ["--report", "reportPath"],
    ["--warehouse", "warehouse"],
  ]);

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--offline") {
      options.offline = true;
      continue;
    }
    if (argument === "--project") {
      const value = readOptionValue(argumentsList, index, argument);
      options.projectIds.push(requirePathId(value, "project id"));
      index += 1;
      continue;
    }
    if (argument === "--page-size") {
      const value = Number(readOptionValue(argumentsList, index, argument));
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
        throw new Error(`--page-size must be from 1 to ${MAX_PAGE_SIZE}.`);
      }
      options.pageSize = value;
      index += 1;
      continue;
    }
    const target = valueOptions.get(argument);
    if (target !== undefined) {
      const value = readOptionValue(argumentsList, index, argument);
      options[target] = target.endsWith("Path") ? path.resolve(value) : value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown analytics verification option: ${argument}`);
  }

  options.projectIds = [...new Set(options.projectIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (options.help) return options;
  if (!options.offline && !resourceNamePattern.test(options.database ?? "")) {
    throw new Error("--database must be a valid remote D1 database name.");
  }
  for (const [label, value] of [
    ["--bucket", options.bucket],
    ["--warehouse", options.warehouse],
  ]) {
    if (value !== undefined && !resourceNamePattern.test(value)) {
      throw new Error(`${label} has an invalid value.`);
    }
  }
  if (options.accountId !== undefined && !/^[A-Fa-f0-9]{32}$/.test(options.accountId)) {
    throw new Error("--account-id must be a 32-character Cloudflare account id.");
  }
  return options;
}

export function defaultAcceptanceReportPath(repoRoot, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Analytics acceptance report time is invalid.");
  }
  const timestamp = now.toISOString().replaceAll(":", "-");
  return path.join(repoRoot, "audits", "analytics-acceptance", `production-${timestamp}.json`);
}

export async function writePrivateJsonReport(outputPath, value) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
}

export function buildAcceptanceProjectsSql(projectIds = [], sourceCutoffMs = Date.now()) {
  const cutoff = positiveWholeNumber(sourceCutoffMs, "source cutoff");
  const selectedProjects =
    projectIds.length === 0
      ? ""
      : `\n  AND project.id IN (${projectIds.map((value) => sqlString(requirePathId(value, "project id"))).join(", ")})`;
  return assertReadOnlySql(`SELECT
  project.id AS project_id,
  project.jurisdiction,
  completion.source_session_count,
  completion.source_cutoff_ms,
  completion.required_sequence,
  completion.report_id,
  completion.completed_at,
  COALESCE(state.verified_sequence, 0) AS verified_sequence,
  state.verified_at,
  (
    SELECT COUNT(*)
    FROM sessions expired_session
    LEFT JOIN session_deletions expired_deletion
      ON expired_deletion.project_id = expired_session.project_id
      AND expired_deletion.session_id = expired_session.session_id
    WHERE expired_session.project_id = project.id
      AND expired_session.expires_at < ${cutoff}
      AND expired_deletion.session_id IS NULL
  ) AS expired_unswept_count,
  (
    SELECT COUNT(*)
    FROM session_deletions deletion
    WHERE deletion.project_id = project.id
  ) AS deletion_count
FROM projects project
LEFT JOIN analytics_backfill_completions completion ON completion.project_id = project.id
LEFT JOIN analytics_warehouse_state state ON state.project_id = project.id
WHERE project.jurisdiction IS NULL${selectedProjects}
ORDER BY project.id`);
}

export function buildD1SessionPageSql(input) {
  const projectId = requirePathId(input.projectId, "project id");
  const version = wholeNumber(input.warehouseVersion, "warehouse version");
  const cursor = requireCursor(input.afterSessionId);
  const pageSize = pageNumber(input.pageSize);
  const project = sqlString(projectId);

  return assertReadOnlySql(`WITH export_refs AS (
  SELECT export_id, export_sequence, session_id, record_kind
  FROM analytics_export_outbox
  WHERE project_id = ${project} AND export_sequence <= ${version}
  UNION
  SELECT export_id, export_sequence, session_id, record_kind
  FROM analytics_export_ledger
  WHERE project_id = ${project} AND export_sequence <= ${version}
),
verified_sessions AS (
  SELECT session_id, MAX(export_sequence) AS session_export_sequence
  FROM export_refs
  WHERE record_kind = 'session'
  GROUP BY session_id
),
verified_sparse_events AS (
  SELECT
    session_id,
    MAX(export_sequence) AS event_export_sequence
  FROM export_refs
  WHERE record_kind = 'event'
  GROUP BY session_id
),
source_sparse_events AS (
  SELECT source_event.session_id, COUNT(*) AS sparse_event_count
  FROM session_events source_event
  INNER JOIN verified_sparse_events verified_event
    ON verified_event.session_id = source_event.session_id
  WHERE source_event.project_id = ${project}
  GROUP BY source_event.session_id
)
SELECT
  session.project_id,
  session.session_id,
  ${selectSqlColumns("session", comparedSessionColumns)},
  COALESCE(source_event.sparse_event_count, 0) AS sparse_event_count,
  COALESCE(verified.session_export_sequence, 0) AS session_export_sequence,
  CASE WHEN verified.session_export_sequence IS NULL THEN 0 ELSE 1 END AS has_session_export,
  CASE
    WHEN COALESCE(event.event_export_sequence, 0) > COALESCE(verified.session_export_sequence, 0)
      THEN event.event_export_sequence
    ELSE COALESCE(verified.session_export_sequence, 0)
  END AS highest_sequence
FROM sessions session
LEFT JOIN verified_sessions verified ON verified.session_id = session.session_id
LEFT JOIN verified_sparse_events event ON event.session_id = session.session_id
LEFT JOIN source_sparse_events source_event ON source_event.session_id = session.session_id
LEFT JOIN session_deletions deletion
  ON deletion.project_id = session.project_id AND deletion.session_id = session.session_id
WHERE session.project_id = ${project}
  AND session.session_id > ${sqlString(cursor)}
  AND deletion.session_id IS NULL
ORDER BY session.session_id
LIMIT ${pageSize}`);
}

export function buildD1HighestSequenceSql(projectIdValue, warehouseVersionValue) {
  const project = sqlString(requirePathId(projectIdValue, "project id"));
  const version = wholeNumber(warehouseVersionValue, "warehouse version");
  return assertReadOnlySql(`WITH export_refs AS (
  SELECT export_id, export_sequence
  FROM analytics_export_outbox
  WHERE project_id = ${project} AND export_sequence <= ${version}
  UNION
  SELECT export_id, export_sequence
  FROM analytics_export_ledger
  WHERE project_id = ${project} AND export_sequence <= ${version}
)
SELECT
  ${project} AS project_id,
  COALESCE(MAX(export_sequence), 0) AS highest_verified_sequence
FROM export_refs`);
}

export function buildD1ExportIdentityPageSql(input) {
  const projectId = requirePathId(input.projectId, "project id");
  const project = sqlString(projectId);
  const version = wholeNumber(input.warehouseVersion, "warehouse version");
  const afterSequence = wholeNumber(input.afterSequence, "export sequence cursor");
  const afterExportId = input.afterExportId === "" ? "" : requireExportId(input.afterExportId);
  const pageSize = exportIdPageNumber(input.pageSize);
  return assertReadOnlySql(`WITH export_refs AS (
  SELECT export_id, export_sequence, session_id, record_kind
  FROM analytics_export_outbox
  WHERE project_id = ${project} AND export_sequence <= ${version}
  UNION
  SELECT export_id, export_sequence, session_id, record_kind
  FROM analytics_export_ledger
  WHERE project_id = ${project} AND export_sequence <= ${version}
)
SELECT
  ${project} AS project_id,
  export_id,
  export_sequence,
  session_id,
  record_kind
FROM export_refs
WHERE export_sequence > ${afterSequence}
  OR (export_sequence = ${afterSequence} AND export_id > ${sqlString(afterExportId)})
ORDER BY export_sequence, export_id
LIMIT ${pageSize}`);
}

export function buildR2SessionPageSql(input) {
  const projectId = requirePathId(input.projectId, "project id");
  const project = sqlString(projectId);
  const version = wholeNumber(input.warehouseVersion, "warehouse version");
  const cursor = requireCursor(input.afterSessionId);
  const pageSize = pageNumber(input.pageSize);

  return assertReadOnlySql(`WITH scoped_session_exports AS (
  SELECT
    session.project_id,
    session.export_id,
    session.export_sequence,
    session.session_id,
    session.recorded_at,
    session.event_coverage,
    ${selectSqlColumns("session", comparedSessionColumns)},
    ROW_NUMBER() OVER (
      PARTITION BY session.project_id, session.export_id
      ORDER BY session.export_sequence DESC, session.recorded_at DESC
    ) AS export_retry_rank
  FROM "default"."analytics_sessions" session
  WHERE session.project_id = ${project}
    AND session.export_sequence <= ${version}
    AND session.session_id > ${sqlString(cursor)}
    AND session.org_id IS NOT NULL
    AND session.started_at IS NOT NULL
    AND session.ended_at IS NOT NULL
    AND session.duration_ms IS NOT NULL
    AND session.url_count IS NOT NULL
    AND session.analytics_version IS NOT NULL
    AND session.clicks IS NOT NULL
    AND session.event_count IS NOT NULL
    AND session.errors IS NOT NULL
    AND session.rages IS NOT NULL
    AND session.navs IS NOT NULL
    AND session.bytes IS NOT NULL
    AND session.segment_count IS NOT NULL
    AND session.flags IS NOT NULL
    AND session.manifest_key IS NOT NULL
    AND session.expires_at IS NOT NULL
),
one_session_export AS (
  SELECT
    project_id,
    export_id,
    export_sequence,
    session_id,
    recorded_at,
    event_coverage,
    ${comparedSessionColumns.join(",\n    ")}
  FROM scoped_session_exports
  WHERE export_retry_rank = 1
),
ranked_sessions AS (
  SELECT
    session.project_id,
    session.export_id,
    session.export_sequence,
    session.session_id,
    session.recorded_at,
    session.event_coverage,
    ${selectSqlColumns("session", comparedSessionColumns)},
    ROW_NUMBER() OVER (
      PARTITION BY session.project_id, session.session_id
      ORDER BY session.export_sequence DESC, session.recorded_at DESC, session.export_id DESC
    ) AS session_rank
  FROM one_session_export session
),
scoped_deletion_exports AS (
  SELECT
    deletion.project_id,
    deletion.export_id,
    deletion.export_sequence,
    deletion.session_id,
    deletion.recorded_at,
    ROW_NUMBER() OVER (
      PARTITION BY deletion.project_id, deletion.export_id
      ORDER BY deletion.export_sequence DESC, deletion.recorded_at DESC
    ) AS export_retry_rank
  FROM "default"."analytics_deletions" deletion
  WHERE deletion.project_id = ${project}
    AND deletion.session_id > ${sqlString(cursor)}
    AND deletion.deleted_at IS NOT NULL
    AND deletion.delete_reason IS NOT NULL
),
deleted_sessions AS (
  SELECT DISTINCT deletion.project_id, deletion.session_id
  FROM scoped_deletion_exports deletion
  WHERE deletion.export_retry_rank = 1
),
live_sessions AS (
  SELECT
    session.project_id,
    session.export_id,
    session.export_sequence,
    session.session_id,
    session.recorded_at,
    session.event_coverage,
    ${selectSqlColumns("session", comparedSessionColumns)}
  FROM ranked_sessions session
  WHERE session.session_rank = 1
    AND NOT EXISTS (
      SELECT 1
      FROM deleted_sessions deletion
      WHERE deletion.project_id = session.project_id
        AND deletion.session_id = session.session_id
    )
),
paged_sessions AS (
  SELECT
    project_id,
    export_id,
    export_sequence,
    session_id,
    recorded_at,
    event_coverage,
    ${comparedSessionColumns.join(",\n    ")}
  FROM live_sessions
  ORDER BY session_id
  LIMIT ${pageSize}
),
scoped_sparse_event_exports AS (
  SELECT
    event.project_id,
    event.export_id,
    event.export_sequence,
    event.session_id,
    event.recorded_at,
    ROW_NUMBER() OVER (
      PARTITION BY event.project_id, event.export_id
      ORDER BY event.export_sequence DESC, event.recorded_at DESC
    ) AS export_retry_rank
  FROM "default"."analytics_events" event
  INNER JOIN paged_sessions session
    ON session.project_id = event.project_id AND session.session_id = event.session_id
  WHERE event.project_id = ${project}
    AND event.export_sequence <= ${version}
    AND session.event_coverage = 'sparse'
    AND event.event_kind <> 'coverage_complete'
    AND event.event_index IS NOT NULL
    AND event.event_time IS NOT NULL
    AND event.event_kind IS NOT NULL
),
one_sparse_event_export AS (
  SELECT session_id, export_sequence
  FROM scoped_sparse_event_exports
  WHERE export_retry_rank = 1
),
sparse_event_counts AS (
  SELECT
    session_id,
    COUNT(*) AS sparse_event_count,
    MAX(export_sequence) AS event_export_sequence
  FROM one_sparse_event_export
  GROUP BY session_id
)
SELECT
  session.project_id,
  session.session_id,
  ${selectSqlColumns("session", comparedSessionColumns)},
  COALESCE(event.sparse_event_count, 0) AS sparse_event_count,
  session.export_sequence AS session_export_sequence,
  CASE
    WHEN COALESCE(event.event_export_sequence, 0) > session.export_sequence
      THEN event.event_export_sequence
    ELSE session.export_sequence
  END AS highest_sequence
FROM paged_sessions session
LEFT JOIN sparse_event_counts event ON event.session_id = session.session_id
ORDER BY session.session_id
LIMIT ${pageSize}`);
}

export function buildR2HighestSequenceSql(projectIdValue, warehouseVersionValue) {
  const project = sqlString(requirePathId(projectIdValue, "project id"));
  const version = wholeNumber(warehouseVersionValue, "warehouse version");
  return assertReadOnlySql(`WITH export_rows AS (
  SELECT export_id, export_sequence
  FROM "default"."analytics_sessions"
  WHERE project_id = ${project} AND export_sequence <= ${version}
  UNION ALL
  SELECT export_id, export_sequence
  FROM "default"."analytics_events"
  WHERE project_id = ${project} AND export_sequence <= ${version}
  UNION ALL
  SELECT export_id, export_sequence
  FROM "default"."analytics_deletions"
  WHERE project_id = ${project} AND export_sequence <= ${version}
),
ranked_exports AS (
  SELECT
    export_id,
    export_sequence,
    ROW_NUMBER() OVER (
      PARTITION BY export_id ORDER BY export_sequence DESC
    ) AS export_retry_rank
  FROM export_rows
)
SELECT
  ${project} AS project_id,
  COALESCE(MAX(export_sequence), 0) AS highest_verified_sequence
FROM ranked_exports
WHERE export_retry_rank = 1`);
}

export function buildR2ExportIdentityQuery(input) {
  const projectId = requirePathId(input.projectId, "project id");
  const project = sqlString(projectId);
  const version = wholeNumber(input.warehouseVersion, "warehouse version");
  if (
    !Array.isArray(input.identities) ||
    input.identities.length < 1 ||
    input.identities.length > MAX_EXPORT_ID_PAGE_SIZE
  ) {
    throw new Error(
      `R2 SQL export identity checks need 1 to ${MAX_EXPORT_ID_PAGE_SIZE} identities.`,
    );
  }
  const identities = input.identities.map((identity) => ({
    exportId: requireExportId(identity?.exportId),
    recordKind: requireRecordKind(identity?.recordKind, "expected export kind"),
  }));
  if (new Set(identities.map((identity) => identity.exportId)).size !== identities.length) {
    throw new Error("R2 SQL export identity checks cannot contain duplicate ids.");
  }
  const tableByKind = {
    deletion: "analytics_deletions",
    event: "analytics_events",
    session: "analytics_sessions",
  };
  const guardsByKind = {
    deletion: `schema_version IS NOT NULL
    AND recorded_at IS NOT NULL
    AND deleted_at IS NOT NULL
    AND delete_reason IS NOT NULL`,
    event: `schema_version IS NOT NULL
    AND recorded_at IS NOT NULL
    AND event_index IS NOT NULL
    AND event_time IS NOT NULL
    AND event_kind IS NOT NULL`,
    session: `schema_version IS NOT NULL
    AND recorded_at IS NOT NULL
    AND event_coverage IN ('sparse', 'complete')
    AND org_id IS NOT NULL
    AND started_at IS NOT NULL
    AND ended_at IS NOT NULL
    AND duration_ms IS NOT NULL
    AND url_count IS NOT NULL
    AND analytics_version IS NOT NULL
    AND clicks IS NOT NULL
    AND event_count IS NOT NULL
    AND errors IS NOT NULL
    AND rages IS NOT NULL
    AND navs IS NOT NULL
    AND bytes IS NOT NULL
    AND segment_count IS NOT NULL
    AND flags IS NOT NULL
    AND manifest_key IS NOT NULL
    AND expires_at IS NOT NULL
    AND (event_coverage <> 'complete' OR analytics_sidecar_key IS NOT NULL)`,
  };
  const selects = [];
  for (const recordKind of ["session", "event", "deletion"]) {
    const ids = identities
      .filter((identity) => identity.recordKind === recordKind)
      .map((identity) => sqlString(identity.exportId));
    if (ids.length === 0) continue;
    selects.push(`SELECT project_id, export_id, export_sequence, session_id, record_kind
  FROM "default"."${tableByKind[recordKind]}"
  WHERE project_id = ${project}
    AND record_kind = '${recordKind}'
    AND export_sequence <= ${version}
    AND export_id IN (${ids.join(", ")})
    AND ${guardsByKind[recordKind]}`);
  }
  return assertReadOnlySql(`WITH export_rows AS (
  ${selects.join("\n  UNION ALL\n  ")}
),
ranked_exports AS (
  SELECT
    project_id,
    export_id,
    export_sequence,
    session_id,
    record_kind,
    ROW_NUMBER() OVER (
      PARTITION BY record_kind, export_id ORDER BY export_sequence DESC
    ) AS export_retry_rank
  FROM export_rows
)
SELECT project_id, export_id, export_sequence, session_id, record_kind
FROM ranked_exports
WHERE export_retry_rank = 1
ORDER BY export_sequence, export_id
LIMIT ${MAX_EXPORT_ID_PAGE_SIZE}`);
}

export function normalizeExportIdentities(rows, projectIdValue, warehouseVersionValue, label) {
  if (!Array.isArray(rows)) throw new Error(`${label} export identities must be an array.`);
  const projectId = requirePathId(projectIdValue, "project id");
  const warehouseVersion = nonNegativeWholeNumber(warehouseVersionValue, "warehouse version");
  const seen = new Set();
  return rows.map((row, index) => {
    if (!isRecord(row) || row.project_id !== projectId) {
      throw new Error(`${label} export identity ${index + 1} belongs to the wrong project.`);
    }
    const exportId = requireExportId(row.export_id);
    if (seen.has(exportId)) throw new Error(`${label} returned export ${exportId} twice.`);
    seen.add(exportId);
    const exportSequence = nonNegativeWholeNumber(row.export_sequence, `${label} export sequence`);
    if (exportSequence < 1 || exportSequence > warehouseVersion) {
      throw new Error(`${label} returned an export outside the warehouse version.`);
    }
    const recordKind = row.record_kind;
    if (recordKind !== "session" && recordKind !== "event" && recordKind !== "deletion") {
      throw new Error(`${label} returned an unknown export kind.`);
    }
    return {
      exportId,
      exportSequence,
      projectId,
      recordKind,
      sessionId: requirePathId(row.session_id, `${label} export session id`),
    };
  });
}

export function compareExportIdentities(expected, actual) {
  const expectedById = new Map(expected.map((identity) => [identity.exportId, identity]));
  const actualById = new Map(actual.map((identity) => [identity.exportId, identity]));
  if (expectedById.size !== expected.length) {
    throw new Error("D1 returned the same export identity more than once.");
  }
  if (actualById.size !== actual.length) {
    throw new Error("R2 SQL returned the same export identity more than once.");
  }
  const missing = [];
  const mismatched = [];
  const unexpected = [];
  for (const [exportId, expectedIdentity] of expectedById) {
    const actualIdentity = actualById.get(exportId);
    if (actualIdentity === undefined) {
      missing.push(expectedIdentity);
      continue;
    }
    if (
      actualIdentity.exportSequence !== expectedIdentity.exportSequence ||
      actualIdentity.recordKind !== expectedIdentity.recordKind ||
      actualIdentity.sessionId !== expectedIdentity.sessionId
    ) {
      mismatched.push({ actual: actualIdentity, expected: expectedIdentity });
    }
  }
  for (const [exportId, actualIdentity] of actualById) {
    if (!expectedById.has(exportId)) unexpected.push(actualIdentity);
  }
  return {
    actualCount: actual.length,
    expectedCount: expected.length,
    match: missing.length === 0 && mismatched.length === 0 && unexpected.length === 0,
    mismatched,
    missing,
    unexpected,
  };
}

export function normalizeAcceptanceRows(rows, projectIdValue, warehouseVersionValue, label) {
  if (!Array.isArray(rows)) throw new Error(`${label} rows must be an array.`);
  const projectId = requirePathId(projectIdValue, "project id");
  const warehouseVersion = nonNegativeWholeNumber(warehouseVersionValue, "warehouse version");
  const seen = new Set();
  return rows.map((row, index) => {
    if (!isRecord(row) || row.project_id !== projectId) {
      throw new Error(`${label} row ${index + 1} belongs to the wrong project.`);
    }
    const sessionId = requirePathId(row.session_id, `${label} session id`);
    if (seen.has(sessionId)) throw new Error(`${label} returned session ${sessionId} twice.`);
    seen.add(sessionId);
    const normalized = {
      activityHist: nullableText(row.activity_hist, `${label} activity histogram`),
      analyticsVersion: nonNegativeWholeNumber(row.analytics_version, `${label} analytics version`),
      browser: nullableText(row.browser, `${label} browser`),
      bytes: nonNegativeWholeNumber(row.bytes, `${label} bytes`),
      city: nullableText(row.city, `${label} city`),
      clicks: nonNegativeWholeNumber(row.clicks, `${label} clicks`),
      country: nullableText(row.country, `${label} country`),
      device: nullableText(row.device, `${label} device`),
      durationMs: nonNegativeWholeNumber(row.duration_ms, `${label} duration`),
      endedAt: nonNegativeWholeNumber(row.ended_at, `${label} ended time`),
      entryUrl: nullableText(row.entry_url, `${label} entry URL`),
      errors: nonNegativeWholeNumber(row.errors, `${label} errors`),
      expiresAt: nonNegativeWholeNumber(row.expires_at, `${label} expiry time`),
      flags: nonNegativeWholeNumber(row.flags, `${label} flags`),
      hasSessionExport:
        row.has_session_export === undefined
          ? true
          : nonNegativeWholeNumber(row.has_session_export, `${label} session export flag`) === 1,
      highestSequence: nonNegativeWholeNumber(row.highest_sequence, `${label} highest sequence`),
      interactionTimeMs: nullableWholeNumber(row.interaction_time_ms, `${label} interaction time`),
      manifestKey: requiredText(row.manifest_key, `${label} manifest key`),
      maxScrollDepth: nullableWholeNumber(row.max_scroll_depth, `${label} max scroll depth`),
      navs: nonNegativeWholeNumber(row.navs, `${label} navigations`),
      orgId: requiredText(row.org_id, `${label} org id`),
      os: nullableText(row.os, `${label} operating system`),
      pageCount: nullableWholeNumber(row.page_count, `${label} page count`),
      projectId,
      quickBacks: nullableWholeNumber(row.quick_backs, `${label} quick backs`),
      rages: nonNegativeWholeNumber(row.rages, `${label} rages`),
      region: nullableText(row.region, `${label} region`),
      segmentCount: nonNegativeWholeNumber(row.segment_count, `${label} segment count`),
      sessionId,
      sparseEventCount: nonNegativeWholeNumber(
        row.sparse_event_count,
        `${label} sparse event count`,
      ),
      startedAt: nonNegativeWholeNumber(row.started_at, `${label} started time`),
      urlCount: nonNegativeWholeNumber(row.url_count, `${label} URL count`),
    };
    if (normalized.highestSequence > warehouseVersion) {
      throw new Error(`${label} returned a row after the warehouse version.`);
    }
    return normalized;
  });
}

export function compareAcceptanceRows(d1Rows, r2Rows) {
  const d1Days = aggregateDays(d1Rows);
  const r2Days = aggregateDays(r2Rows);
  const dayNames = [...new Set([...d1Days.keys(), ...r2Days.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  const days = dayNames.map((day) => {
    const d1 = d1Days.get(day) ?? emptyDay();
    const r2 = r2Days.get(day) ?? emptyDay();
    const mismatches = [];
    compareField(mismatches, "sessionIds", d1.sessionIds, r2.sessionIds);
    for (const field of [
      "sessionCount",
      "bytes",
      "clicks",
      "errors",
      "rages",
      "sparseEventCount",
      "highestSequence",
    ]) {
      compareField(mismatches, field, d1[field], r2[field]);
    }
    return { day, d1, match: mismatches.length === 0, mismatches, r2 };
  });
  const sessionMismatches = compareSessionValues(d1Rows, r2Rows);
  return {
    days,
    match: days.every((day) => day.match) && sessionMismatches.length === 0,
    sessionMismatches,
  };
}

export function readR2SqlResponse(body, projectIdValue) {
  const projectId = requirePathId(projectIdValue, "project id");
  if (
    !isRecord(body) ||
    body.success !== true ||
    !isRecord(body.result) ||
    !Array.isArray(body.result.rows) ||
    !Array.isArray(body.result.schema) ||
    !isRecord(body.result.metrics)
  ) {
    throw new Error("R2 SQL returned an invalid answer.");
  }
  for (const [index, row] of body.result.rows.entries()) {
    if (!isRecord(row) || row.project_id !== projectId) {
      throw new Error(`R2 SQL row ${index + 1} belongs to the wrong project.`);
    }
  }
  const bytesScanned = finiteNonNegativeNumber(body.result.metrics.bytes_scanned, "bytes scanned");
  const filesScanned = finiteNonNegativeNumber(body.result.metrics.files_scanned, "files scanned");
  return { bytesScanned, filesScanned, rows: body.result.rows };
}

export function assertReadOnlySql(sql) {
  const text = String(sql).trim();
  if (!/^(SELECT|WITH|PRAGMA)\b/i.test(text) || forbiddenSqlPattern.test(text)) {
    throw new Error("Analytics acceptance SQL must be read-only.");
  }
  return text;
}

export function readWholeNumber(value, label) {
  return nonNegativeWholeNumber(value, label);
}

function aggregateDays(rows) {
  const days = new Map();
  for (const row of rows) {
    const day = new Date(row.startedAt).toISOString().slice(0, 10);
    const current = days.get(day) ?? emptyDay();
    current.sessionIds.push(row.sessionId);
    current.sessionCount += 1;
    current.bytes = safeSum(current.bytes, row.bytes, "byte total");
    current.clicks = safeSum(current.clicks, row.clicks, "click total");
    current.errors = safeSum(current.errors, row.errors, "error total");
    current.rages = safeSum(current.rages, row.rages, "rage total");
    current.sparseEventCount = safeSum(
      current.sparseEventCount,
      row.sparseEventCount,
      "sparse event total",
    );
    current.highestSequence = Math.max(current.highestSequence, row.highestSequence);
    days.set(day, current);
  }
  for (const value of days.values())
    value.sessionIds.sort((left, right) => left.localeCompare(right));
  return days;
}

function emptyDay() {
  return {
    bytes: 0,
    clicks: 0,
    errors: 0,
    highestSequence: 0,
    rages: 0,
    sessionCount: 0,
    sessionIds: [],
    sparseEventCount: 0,
  };
}

function compareField(mismatches, field, d1, r2) {
  if (JSON.stringify(d1) !== JSON.stringify(r2)) mismatches.push({ d1, field, r2 });
}

function compareSessionValues(d1Rows, r2Rows) {
  const d1BySession = new Map(d1Rows.map((row) => [row.sessionId, row]));
  const r2BySession = new Map(r2Rows.map((row) => [row.sessionId, row]));
  const sharedSessionIds = [...d1BySession.keys()]
    .filter((sessionId) => r2BySession.has(sessionId))
    .sort((left, right) => left.localeCompare(right));
  const mismatches = [];

  for (const sessionId of sharedSessionIds) {
    const d1 = d1BySession.get(sessionId);
    const r2 = r2BySession.get(sessionId);
    for (const field of normalizedSessionValueFields) {
      if (JSON.stringify(d1[field]) !== JSON.stringify(r2[field])) {
        mismatches.push({ d1: d1[field], field, r2: r2[field], sessionId });
      }
    }
  }
  return mismatches;
}

function safeSum(left, right, label) {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error(`${label} is too large to compare safely.`);
  return total;
}

function finiteNonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`R2 SQL ${label} is invalid.`);
  }
  return value;
}

function nonNegativeWholeNumber(value, label) {
  const number = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative whole number.`);
  }
  return number;
}

function nullableWholeNumber(value, label) {
  return value === null || value === undefined ? null : nonNegativeWholeNumber(value, label);
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be non-empty text.`);
  }
  return value;
}

function nullableText(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${label} must be text or null.`);
  return value;
}

function positiveWholeNumber(value, label) {
  const number = nonNegativeWholeNumber(value, label);
  if (number < 1) throw new Error(`${label} must be a positive whole number.`);
  return String(number);
}

function wholeNumber(value, label) {
  return String(nonNegativeWholeNumber(value, label));
}

function selectSqlColumns(alias, columns) {
  return columns.map((column) => `${alias}.${column}`).join(",\n    ");
}

function pageNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error(`page size must be from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return String(value);
}

function exportIdPageNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EXPORT_ID_PAGE_SIZE) {
    throw new Error(`export identity page size must be from 1 to ${MAX_EXPORT_ID_PAGE_SIZE}.`);
  }
  return String(value);
}

function requireCursor(value) {
  if (value === "") return value;
  return requirePathId(value, "session cursor");
}

function requirePathId(value, label) {
  if (typeof value !== "string" || !pathIdPattern.test(value)) {
    throw new Error(`${label} must be 1 to 64 letters, numbers, dashes, or underscores.`);
  }
  return value;
}

function requireExportId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new Error("export id must be between 1 and 512 characters.");
  }
  return value;
}

function requireRecordKind(value, label) {
  if (value !== "session" && value !== "event" && value !== "deletion") {
    throw new Error(`${label} must be session, event, or deletion.`);
  }
  return value;
}

function sqlString(value) {
  if (typeof value !== "string") throw new Error("SQL values must be text.");
  return `'${value.replaceAll("'", "''")}'`;
}

function readOptionValue(argumentsList, index, argument) {
  const value = argumentsList[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${argument} needs a value.`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
