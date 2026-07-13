#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildEventOutboxRecords,
  buildBackfillCompletionSql,
  buildOutboxInsertBatches,
  buildSessionEventsQueries,
  buildSessionOutboxRecord,
  classifySession,
  manifestIdentityFromKey,
  parseBackfillArguments,
  parseManifestInventory,
  sessionColumns,
  sqlString,
  usesDefaultAnalyticsCatalog,
  validateManifestText,
} from "./analytics/backfill-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helpText = `Usage: node scripts/backfill-analytics.mjs [options]

Required:
  --source <local|production>     Keeps local and production inventories separate
  --database <name>              D1 database containing sessions
  --recordings-bucket <name>     R2 replay bucket containing manifests
  --inventory <file>             JSON or newline list of every R2 object key

Optional:
  --apply                        Write idempotent rows into analytics_export_outbox
  --config <file>                Wrangler config
  --env <name>                   Wrangler environment
  --persist-to <dir>             Local Wrangler state directory (local only)
  --page-size <1..500>           D1 page size (default: 100)
  --now <milliseconds>           Fixed expiry cutoff for a repeatable report
  --report <file>                Report path
  --help                         Show this help

Without --apply, the script only reads data and writes an audit report. It reads
manifest.json files only. It never reads or inflates replay segments.`;

class BackfillStateChangedError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "BackfillStateChangedError";
    this.kind = kind;
  }
}

let activeReport;
let activeReportPath;

try {
  const options = parseBackfillArguments(process.argv.slice(2), {});
  if (options.help) {
    console.log(helpText);
    process.exit(0);
  }

  const inventoryKeys = parseManifestInventory(await readFile(options.inventoryPath, "utf8"));
  assertD1Schema(options);
  const reportPath = options.reportPath ?? defaultReportPath(options.source);
  activeReportPath = reportPath;
  const reportId = `backfill_${randomUUID()}`;
  const manifestKeys = inventoryKeys.filter((key) => key.endsWith("/manifest.json"));
  const inventorySet = new Set(manifestKeys);
  const manifestChecks = validateManifests(manifestKeys, new Set(inventoryKeys), options);
  const activeDeletionRows = queryCount("SELECT COUNT(*) AS value FROM session_deletions", options);
  const report = makeReport(
    options,
    reportId,
    inventoryKeys.length,
    manifestKeys.length,
    activeDeletionRows,
  );
  activeReport = report;
  report.totals.missingSegmentObjects = [...manifestChecks.values()].reduce(
    (total, check) => total + (check.missingSegmentCount ?? 0),
    0,
  );
  const indexedManifestKeys = new Set();
  const sourceSessionCounts = emptyProjectSessionCounts(options);
  const sourceDeletionCounts = readProjectDeletionCounts(options);
  scanSourceSessions(
    options,
    inventorySet,
    manifestChecks,
    report,
    indexedManifestKeys,
    sourceSessionCounts,
  );
  report.projects = projectCountReport(sourceSessionCounts);

  for (const key of manifestKeys) {
    if (!indexedManifestKeys.has(key)) report.totals.orphanManifests += 1;
    if (manifestChecks.get(key)?.ok !== true) report.totals.invalidManifests += 1;
  }
  report.totals.skipped =
    report.totals.deleted +
    report.totals.expired +
    report.totals.missing +
    report.totals.invalid +
    report.totals.residencySkipped;
  let appliedRequiredSequences = new Map();
  if (options.apply) {
    if (report.totals.missing > 0 || report.totals.invalid > 0) {
      throw new Error(
        "Analytics backfill stopped before writing because a current recording is missing or invalid.",
      );
    }
    const applied = applySourceSessions(options, inventorySet, manifestChecks);
    assertSameProjectState(
      sourceSessionCounts,
      sourceDeletionCounts,
      applied.sourceSessionCounts,
      applied.deletionCounts,
      "apply scan",
    );
    const readbackCounts = readSourceSessionCounts(options);
    const readbackDeletionCounts = readProjectDeletionCounts(options);
    assertSameProjectState(
      sourceSessionCounts,
      sourceDeletionCounts,
      readbackCounts,
      readbackDeletionCounts,
      "source readback",
    );
    appliedRequiredSequences = applied.requiredSequences;
    report.projects = projectCountReport(sourceSessionCounts, appliedRequiredSequences);
    report.totals.outboxRowsInserted = applied.inserted;
    report.totals.outboxRowsAlreadyPresent =
      report.totals.outboxRowsExpected - report.totals.outboxRowsInserted;
  }
  const completedAt = Date.now();
  report.completedAt = new Date(completedAt).toISOString();
  report.status = "complete";

  await writeBackfillReport(reportPath, report);
  if (options.apply) {
    writeBackfillCompletions(
      options,
      sourceSessionCounts,
      sourceDeletionCounts,
      appliedRequiredSequences,
      reportId,
      completedAt,
    );
  }
  console.log(
    JSON.stringify(
      {
        event: "analytics.backfill",
        mode: options.apply ? "apply" : "dry_run",
        reportPath,
        source: options.source,
        totals: report.totals,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (activeReport !== undefined && activeReportPath !== undefined) {
    activeReport.status = "aborted";
    activeReport.abortReason = message;
    activeReport.completedAt = new Date().toISOString();
    markStateChangeInReport(activeReport, error);
    try {
      await writeBackfillReport(activeReportPath, activeReport);
    } catch (reportError) {
      console.error(
        reportError instanceof Error
          ? `Analytics backfill also failed to write its aborted report: ${reportError.message}`
          : "Analytics backfill also failed to write its aborted report.",
      );
    }
  }
  console.error(message);
  process.exit(1);
}

function readSessionPage(options, cursor) {
  const cursorSql =
    cursor === undefined
      ? ""
      : `AND (s.project_id > ${sqlString(cursor.projectId)} OR (s.project_id = ${sqlString(
          cursor.projectId,
        )} AND s.session_id > ${sqlString(cursor.sessionId)}))`;
  const sql = `SELECT ${sessionColumns.map((column) => `s.${column}`).join(", ")},
      p.id AS catalog_project_id,
      p.jurisdiction AS project_jurisdiction,
      EXISTS (
        SELECT 1 FROM session_deletions d
        WHERE d.project_id = s.project_id AND d.session_id = s.session_id
      ) AS is_deleted
    FROM sessions s
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.ended_at <= ${options.now}
    ${cursorSql}
    ORDER BY s.project_id, s.session_id
    LIMIT ${options.pageSize}`;
  return queryRows(sql, options);
}

function readEventsForSessions(sessions, options) {
  const grouped = new Map();
  if (sessions.length === 0) return grouped;
  for (const batch of buildSessionEventsQueries(sessions)) {
    const rows = queryRows(batch.sql, options);
    for (const row of rows) {
      const key = `${row.project_id}\0${row.session_id}`;
      const current = grouped.get(key) ?? [];
      current.push(row);
      grouped.set(key, current);
    }
  }
  return grouped;
}

function validateManifests(keys, inventoryKeys, options) {
  const checks = new Map();
  for (const key of keys) {
    if (manifestIdentityFromKey(key) === undefined) {
      checks.set(key, { ok: false, reason: "invalid_manifest_key" });
      continue;
    }
    const result = runWrangler(
      [
        "r2",
        "object",
        "get",
        `${options.recordingsBucket}/${key}`,
        "--pipe",
        sourceFlag(options),
        ...wranglerPathArgs(options),
      ],
      { allowFailure: true },
    );
    checks.set(
      key,
      result.ok
        ? validateManifestText(key, result.stdout, inventoryKeys)
        : { ok: false, reason: "read_failed" },
    );
  }
  return checks;
}

function insertOutboxRecords(records, options) {
  let inserted = 0;
  const requiredSequences = new Map();
  for (const batch of buildOutboxInsertBatches(records, options.now)) {
    const result = runD1(batch.sql, options);
    const changes = Number(result.at(-1)?.meta?.changes ?? 0);
    if (!Number.isSafeInteger(changes) || changes < 0) {
      throw new Error("D1 returned an invalid outbox insert count.");
    }
    inserted += changes;
    const verified = verifyOutboxRecords(batch.records, options);
    for (const row of verified) {
      keepHighestSequence(requiredSequences, row.projectId, row.exportSequence);
    }
  }
  return { inserted, requiredSequences };
}

function verifyOutboxRecords(records, options) {
  if (records.length === 0) return [];
  const expectedValues = records
    .map(
      (record, index) =>
        `(${index}, ${sqlString(record.exportId)}, ${sqlString(record.projectId)}, ${sqlString(record.sessionId)})`,
    )
    .join(",\n");
  const rows = queryRows(
    `WITH expected(record_order, export_id, project_id, session_id) AS (
       VALUES ${expectedValues}
     )
     SELECT expected.export_id,
       COALESCE(outbox.export_sequence, ledger.export_sequence) AS export_sequence,
       outbox.payload_json,
       CASE
         WHEN outbox.export_id IS NOT NULL THEN 'outbox'
         WHEN ledger.export_id IS NOT NULL THEN 'ledger'
         ELSE NULL
       END AS source,
       EXISTS (
         SELECT 1 FROM projects project
         WHERE project.id = expected.project_id
           AND project.jurisdiction IS NULL
       ) AS project_is_default,
       EXISTS (
         SELECT 1 FROM session_deletions deletion
         WHERE deletion.project_id = expected.project_id
           AND deletion.session_id = expected.session_id
       ) AS is_deleted
     FROM expected
     LEFT JOIN analytics_export_outbox outbox ON outbox.export_id = expected.export_id
     LEFT JOIN analytics_export_ledger ledger
       ON ledger.export_id = expected.export_id
       AND outbox.export_id IS NULL
     ORDER BY expected.record_order`,
    options,
  );
  const byId = new Map(rows.map((row) => [row.export_id, row]));
  const verified = [];
  for (const record of records) {
    const stored = byId.get(record.exportId);
    if (stored === undefined) {
      throw new Error(`Analytics backfill could not verify export ${record.exportId}.`);
    }
    if (Number(stored.is_deleted) > 0) {
      throw new BackfillStateChangedError(
        "deletion",
        `Analytics backfill aborted and skipped session ${record.projectId}/${record.sessionId} because it was deleted during apply.`,
      );
    }
    if (Number(stored.project_is_default) !== 1) {
      throw new BackfillStateChangedError(
        "residency",
        `Analytics backfill aborted and skipped project ${record.projectId} because it was removed or changed away from default residency during apply.`,
      );
    }
    if (stored.source === null || stored.source === undefined) {
      throw new BackfillStateChangedError(
        "guarded_insert",
        `Analytics backfill aborted because guarded insert skipped ${record.exportId}; deletion or residency changed during apply.`,
      );
    }
    if (stored.source === "outbox" && stored.payload_json !== JSON.stringify(record.payload)) {
      throw new Error(`Analytics backfill found different data for export ${record.exportId}.`);
    }
    const exportSequence = Number(stored.export_sequence);
    if (!Number.isSafeInteger(exportSequence) || exportSequence <= 0) {
      throw new Error(
        `Analytics backfill found an invalid sequence for export ${record.exportId}.`,
      );
    }
    verified.push({ exportSequence, projectId: record.projectId });
  }
  return verified;
}

function scanSourceSessions(
  options,
  inventorySet,
  manifestChecks,
  report,
  indexedManifestKeys,
  sourceSessionCounts,
) {
  let cursor;
  for (;;) {
    const sessions = readSessionPage(options, cursor);
    if (sessions.length === 0) break;
    const migratedSessions = [];
    for (const session of sessions) {
      indexedManifestKeys.add(session.manifest_key);
      report.totals.sourceSessions += 1;
      if (!isDefaultCatalogSession(session)) {
        report.totals.residencySkipped += 1;
        continue;
      }
      incrementProjectCount(sourceSessionCounts, session.project_id);
      const classification = classifySession(session, inventorySet, manifestChecks, options.now);
      report.totals[classification] += 1;
      if (classification === "migrated") migratedSessions.push(session);
    }
    const records = recordsForSessions(migratedSessions, options, report.totals);
    report.totals.outboxRowsExpected += records.length;
    const last = sessions.at(-1);
    cursor = { projectId: last.project_id, sessionId: last.session_id };
    if (sessions.length < options.pageSize) break;
  }
}

function applySourceSessions(options, inventorySet, manifestChecks) {
  let cursor;
  let inserted = 0;
  const sourceSessionCounts = emptyProjectSessionCounts(options);
  const deletionCounts = readProjectDeletionCounts(options);
  const requiredSequences = new Map();
  for (;;) {
    const sessions = readSessionPage(options, cursor);
    if (sessions.length === 0) break;
    for (const session of sessions) {
      if (isDefaultCatalogSession(session)) {
        incrementProjectCount(sourceSessionCounts, session.project_id);
      }
    }
    const migratedSessions = sessions.filter(
      (session) =>
        isDefaultCatalogSession(session) &&
        classifySession(session, inventorySet, manifestChecks, options.now) === "migrated",
    );
    const result = insertOutboxRecords(recordsForSessions(migratedSessions, options), options);
    inserted += result.inserted;
    mergeHighestSequences(requiredSequences, result.requiredSequences);
    const last = sessions.at(-1);
    cursor = { projectId: last.project_id, sessionId: last.session_id };
    if (sessions.length < options.pageSize) break;
  }
  return { deletionCounts, inserted, requiredSequences, sourceSessionCounts };
}

function emptyProjectSessionCounts(options) {
  const rows = queryRows(
    `SELECT id AS project_id
     FROM projects
     WHERE jurisdiction IS NULL
     ORDER BY project_id`,
    options,
  );
  return new Map(rows.map((row) => [String(row.project_id), 0]));
}

function readSourceSessionCounts(options) {
  const counts = emptyProjectSessionCounts(options);
  const rows = queryRows(
    `SELECT s.project_id, COUNT(*) AS source_session_count
     FROM sessions s
     INNER JOIN projects p ON p.id = s.project_id
     WHERE s.ended_at <= ${options.now}
       AND p.jurisdiction IS NULL
     GROUP BY s.project_id
     ORDER BY s.project_id`,
    options,
  );
  for (const row of rows) {
    const count = Number(row.source_session_count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("D1 returned an invalid project source session count.");
    }
    counts.set(String(row.project_id), count);
  }
  return counts;
}

function readProjectDeletionCounts(options) {
  const rows = queryRows(
    `SELECT project.id AS project_id, COUNT(deletion.session_id) AS active_deletion_count
     FROM projects project
     LEFT JOIN session_deletions deletion ON deletion.project_id = project.id
     WHERE project.jurisdiction IS NULL
     GROUP BY project.id
     ORDER BY project.id`,
    options,
  );
  const counts = new Map();
  for (const row of rows) {
    const count = Number(row.active_deletion_count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("D1 returned an invalid project deletion count.");
    }
    counts.set(String(row.project_id), count);
  }
  return counts;
}

function incrementProjectCount(counts, projectIdValue) {
  const projectId = String(projectIdValue);
  counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
}

function isDefaultCatalogSession(session) {
  return (
    session.catalog_project_id !== null &&
    session.catalog_project_id !== undefined &&
    usesDefaultAnalyticsCatalog(session.project_jurisdiction)
  );
}

function keepHighestSequence(sequences, projectId, exportSequence) {
  sequences.set(projectId, Math.max(sequences.get(projectId) ?? 0, exportSequence));
}

function mergeHighestSequences(target, incoming) {
  for (const [projectId, exportSequence] of incoming) {
    keepHighestSequence(target, projectId, exportSequence);
  }
}

function assertSameProjectState(
  expectedSessionCounts,
  expectedDeletionCounts,
  actualSessionCounts,
  actualDeletionCounts,
  label,
) {
  const expectedProjectIds = [...expectedSessionCounts.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  const actualProjectIds = [...actualSessionCounts.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(expectedProjectIds) !== JSON.stringify(actualProjectIds)) {
    throw new BackfillStateChangedError(
      "residency",
      `Analytics backfill ${label} aborted because the default-residency project set changed while it was running.`,
    );
  }

  if (
    JSON.stringify(projectCountReport(expectedSessionCounts)) !==
    JSON.stringify(projectCountReport(actualSessionCounts))
  ) {
    throw new BackfillStateChangedError(
      "source",
      `Analytics backfill ${label} aborted because source sessions changed while it was running.`,
    );
  }

  if (
    JSON.stringify(projectCountReport(expectedDeletionCounts)) !==
    JSON.stringify(projectCountReport(actualDeletionCounts))
  ) {
    throw new BackfillStateChangedError(
      "deletion",
      `Analytics backfill ${label} aborted because session deletions changed while it was running.`,
    );
  }
}

function projectCountReport(counts, requiredSequences) {
  return [...counts]
    .map(([projectId, sourceSessionCount]) => ({
      projectId,
      requiredSequence: requiredSequences?.get(projectId) ?? null,
      sourceSessionCount,
    }))
    .sort((left, right) => left.projectId.localeCompare(right.projectId));
}

function writeBackfillCompletions(
  options,
  sourceSessionCounts,
  deletionCounts,
  requiredSequences,
  reportId,
  completedAt,
) {
  for (const [projectId, sourceSessionCount] of sourceSessionCounts) {
    const activeDeletionCount = deletionCounts.get(projectId);
    if (!Number.isSafeInteger(activeDeletionCount) || activeDeletionCount < 0) {
      throw new BackfillStateChangedError(
        "residency",
        `Analytics backfill receipt aborted because project ${projectId} left the default-residency project set.`,
      );
    }
    const result = runD1(
      buildBackfillCompletionSql({
        activeDeletionCount,
        completedAt,
        projectId,
        reportId,
        requiredSequence: requiredSequences.get(projectId) ?? 0,
        sourceCutoffMs: options.now,
        sourceSessionCount,
      }),
      options,
    );
    const changes = Number(result.at(-1)?.meta?.changes ?? 0);
    if (changes !== 1) {
      throw completionStateChangedError(
        options,
        projectId,
        sourceSessionCount,
        activeDeletionCount,
      );
    }
  }
}

function completionStateChangedError(
  options,
  projectId,
  expectedSessionCount,
  expectedDeletionCount,
) {
  const row = queryRows(
    `SELECT
       EXISTS (
         SELECT 1 FROM projects project
         WHERE project.id = ${sqlString(projectId)}
           AND project.jurisdiction IS NULL
       ) AS project_is_default,
       (
         SELECT COUNT(*) FROM sessions session
         WHERE session.project_id = ${sqlString(projectId)}
           AND session.ended_at <= ${options.now}
       ) AS source_session_count,
       (
         SELECT COUNT(*) FROM session_deletions deletion
         WHERE deletion.project_id = ${sqlString(projectId)}
       ) AS active_deletion_count`,
    options,
  )[0];
  if (Number(row?.project_is_default) !== 1) {
    return new BackfillStateChangedError(
      "residency",
      `Analytics backfill receipt aborted because project ${projectId} was removed or changed away from default residency.`,
    );
  }
  if (Number(row?.active_deletion_count) !== expectedDeletionCount) {
    return new BackfillStateChangedError(
      "deletion",
      `Analytics backfill receipt aborted because session deletions changed for project ${projectId}.`,
    );
  }
  if (Number(row?.source_session_count) !== expectedSessionCount) {
    return new BackfillStateChangedError(
      "source",
      `Analytics backfill receipt aborted because source sessions changed for project ${projectId}.`,
    );
  }
  return new BackfillStateChangedError(
    "guarded_insert",
    `Analytics backfill receipt aborted because D1 did not confirm the guarded receipt for project ${projectId}.`,
  );
}

function recordsForSessions(sessions, options, totals) {
  const eventsBySession = readEventsForSessions(sessions, options);
  const records = [];
  for (const session of sessions) {
    const events = eventsBySession.get(`${session.project_id}\0${session.session_id}`) ?? [];
    records.push(...buildEventOutboxRecords(session, events));
    records.push(buildSessionOutboxRecord(session, events.length));
    if (totals !== undefined) {
      totals.sparseSessions += 1;
      totals.sparseEvents += events.length;
    }
  }
  return records;
}

function queryRows(sql, options) {
  const result = runD1(sql, options);
  const rows = result.at(-1)?.results;
  if (!Array.isArray(rows)) throw new Error("D1 returned an invalid query result.");
  return rows;
}

function queryCount(sql, options) {
  const value = Number(queryRows(sql, options)[0]?.value);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("D1 returned an invalid count.");
  }
  return value;
}

async function writeBackfillReport(reportPath, report) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function markStateChangeInReport(report, error) {
  if (!(error instanceof BackfillStateChangedError)) return;
  if (error.kind === "deletion") {
    report.totals.concurrentDeletionSkipped += 1;
    report.totals.skipped += 1;
    return;
  }
  if (error.kind === "residency") {
    report.totals.concurrentResidencySkipped += 1;
    report.totals.skipped += 1;
    return;
  }
  report.totals.concurrentStateChangeAborted += 1;
}

function assertD1Schema(options) {
  requireColumns("projects", ["id", "jurisdiction"], options);
  requireColumns("sessions", sessionColumns, options);
  requireColumns("session_events", ["project_id", "session_id", "t", "kind", "detail"], options);
  requireColumns("session_deletions", ["project_id", "session_id"], options);
  if (options.apply) {
    requireColumns(
      "analytics_export_outbox",
      ["export_id", "project_id", "session_id", "record_kind", "payload_json", "created_at"],
      options,
    );
    requireColumns(
      "analytics_export_ledger",
      ["export_id", "project_id", "session_id", "record_kind", "export_sequence"],
      options,
    );
    requireColumns(
      "analytics_backfill_completions",
      [
        "project_id",
        "source_session_count",
        "source_cutoff_ms",
        "required_sequence",
        "report_id",
        "completed_at",
      ],
      options,
    );
  }
}

function requireColumns(table, expectedColumns, options) {
  const rows = queryRows(`PRAGMA table_info(${table})`, options);
  const actualColumns = new Set(rows.map((row) => row.name));
  const missingColumns = expectedColumns.filter((column) => !actualColumns.has(column));
  if (missingColumns.length > 0) {
    throw new Error(
      `D1 table ${table} is missing: ${missingColumns.join(", ")}. Apply reviewed migrations first.`,
    );
  }
}

function runD1(sql, options) {
  const result = runWrangler([
    "d1",
    "execute",
    options.database,
    sourceFlag(options),
    "--command",
    sql,
    "--json",
    ...wranglerPathArgs(options),
  ]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error("Wrangler returned an unreadable D1 response.", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => item.success !== true)) {
    throw new Error("Wrangler returned a failed D1 response.");
  }
  return parsed;
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
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error((result.stderr || result.stdout || "Wrangler command failed.").trim());
  }
  return {
    ok: result.status === 0,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function sourceFlag(options) {
  return options.source === "production" ? "--remote" : "--local";
}

function wranglerPathArgs(options) {
  const args = [];
  if (options.configPath !== undefined) args.push("--config", options.configPath);
  if (options.wranglerEnvironment !== undefined) args.push("--env", options.wranglerEnvironment);
  if (options.persistTo !== undefined) args.push("--persist-to", options.persistTo);
  return args;
}

function makeReport(options, reportId, inventoryObjects, manifestObjects, activeDeletionRows) {
  return {
    abortReason: null,
    completedAt: null,
    eventCoverage: "sparse",
    expiryCutoffMs: options.now,
    mode: options.apply ? "apply" : "dry_run",
    noReplayPayloadRead: true,
    projects: [],
    reportId,
    source: options.source,
    sourceCutoffMs: options.now,
    startedAt: new Date().toISOString(),
    status: "running",
    totals: {
      activeDeletionRows,
      concurrentDeletionSkipped: 0,
      concurrentResidencySkipped: 0,
      concurrentStateChangeAborted: 0,
      deleted: 0,
      expired: 0,
      invalid: 0,
      invalidManifests: 0,
      inventoryObjects,
      manifestObjects,
      migrated: 0,
      missing: 0,
      missingSegmentObjects: 0,
      orphanManifests: 0,
      outboxRowsAlreadyPresent: 0,
      outboxRowsExpected: 0,
      outboxRowsInserted: 0,
      residencySkipped: 0,
      skipped: 0,
      sourceSessions: 0,
      sparseEvents: 0,
      sparseSessions: 0,
    },
  };
}

function defaultReportPath(source) {
  const safeTimestamp = new Date().toISOString().replaceAll(":", "-");
  return path.join(repoRoot, "audits", "analytics-backfill", `${source}-${safeTimestamp}.json`);
}
