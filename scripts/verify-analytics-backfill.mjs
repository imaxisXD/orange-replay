#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { preparePrivateOutputFile } from "./private-file.mjs";
import {
  assertReadOnlySql,
  buildAcceptanceProjectsSql,
  buildD1ExportIdentityPageSql,
  buildD1HighestSequenceSql,
  buildD1SessionPageSql,
  buildR2ExportIdentityQuery,
  buildR2HighestSequenceSql,
  buildR2SessionPageSql,
  compareAcceptanceRows,
  compareExportIdentities,
  defaultAcceptanceReportPath,
  normalizeAcceptanceRows,
  normalizeExportIdentities,
  parseAcceptanceArguments,
  readR2SqlResponse,
  readWholeNumber,
  writePrivateJsonReport,
} from "./analytics/acceptance-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcePath = path.join(repoRoot, "infra", "analytics", "resources.production.json");
const helpText = `Usage: node scripts/verify-analytics-backfill.mjs [options]

Required for a real check:
  --database <name>          Remote production D1 database

Optional:
  --account-id <id>          Cloudflare account id (or CLOUDFLARE_ACCOUNT_ID)
  --bucket <name>            Analytics bucket (defaults to the resource file)
  --warehouse <name>         Optional warehouse label stored in the report
  --config <file>            Wrangler config
  --env <name>               Wrangler environment
  --project <id>             Check one project; repeat to check several
  --page-size <1..5000>      Exact session page size (default: 1000)
  --report <file>            New JSON report path in an existing private directory
  --offline                  Build and print the read-only query plan only
  --help                     Show this help

The R2 SQL token is accepted only through ORANGE_REPLAY_R2_SQL_READ_TOKEN,
ORANGE_REPLAY_PROD_R2_SQL_TOKEN, or WRANGLER_R2_SQL_AUTH_TOKEN. There is no token
command option. This script only
reads remote D1 and R2 SQL, writes a private local report, and exits 1 when any
project, day, session id, aggregate, or verified sequence differs.`;

let report;
let reportPath;
let reportRoot;

try {
  const options = parseAcceptanceArguments(process.argv.slice(2));
  if (options.help) {
    console.log(helpText);
    process.exit(0);
  }
  if (options.offline) {
    console.log(JSON.stringify(makeOfflinePlan(options.pageSize), null, 2));
    process.exit(0);
  }

  const resources = JSON.parse(await readFile(resourcePath, "utf8"));
  const settings = readR2Settings(options, resources);
  const sourceCutoffMs = Date.now();
  reportPath = options.reportPath ?? defaultReportPath();
  reportRoot = options.reportPath === undefined ? repoRoot : path.dirname(reportPath);
  await preparePrivateOutputFile(reportRoot, reportPath);
  report = makeReport(options, settings, reportPath, sourceCutoffMs);
  await verifyD1Schema(options);

  const projectRows = queryD1Rows(
    buildAcceptanceProjectsSql(options.projectIds, sourceCutoffMs),
    options,
  );
  const foundProjectIds = new Set(projectRows.map((row) => String(row.project_id)));
  const missingRequestedProjects = options.projectIds.filter((id) => !foundProjectIds.has(id));
  if (missingRequestedProjects.length > 0) {
    throw new Error(
      `These projects are missing or outside the default analytics residency: ${missingRequestedProjects.join(", ")}.`,
    );
  }
  if (projectRows.length === 0) {
    throw new Error("No default-residency project is available to verify.");
  }

  for (const projectRow of projectRows) {
    const projectResult = await verifyProject(projectRow, options, settings, sourceCutoffMs);
    report.projects.push(projectResult);
    addProjectTotals(report.totals, projectResult);
  }

  report.match = report.projects.every((project) => project.match);
  report.status = report.match ? "matched" : "mismatched";
  report.completedAt = new Date().toISOString();
  await writePrivateJsonReport(reportPath, report, reportRoot);
  console.log(
    JSON.stringify(
      {
        event: "analytics.backfill_acceptance",
        match: report.match,
        reportPath,
        status: report.status,
        totals: report.totals,
      },
      null,
      2,
    ),
  );
  if (!report.match) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (report !== undefined && reportPath !== undefined && reportRoot !== undefined) {
    report.status = "failed";
    report.match = false;
    report.error = message;
    report.completedAt = new Date().toISOString();
    try {
      await writePrivateJsonReport(reportPath, report, reportRoot);
    } catch (reportError) {
      console.error(
        reportError instanceof Error
          ? `Analytics acceptance also failed to write its report: ${reportError.message}`
          : "Analytics acceptance also failed to write its report.",
      );
    }
  }
  console.error(message);
  process.exitCode = 1;
}

async function verifyProject(projectRow, options, settings, sourceCutoffMs) {
  const state = readProjectState(projectRow);
  const issues = [...state.issues];
  const projectResult = {
    d1HighestVerifiedSequence: null,
    days: [],
    exportIdentities: {
      actualCount: 0,
      expectedCount: 0,
      match: false,
      mismatched: [],
      missing: [],
      unexpected: [],
    },
    issues,
    match: false,
    missingSessionExportIds: [],
    projectId: state.projectId,
    expiredUnsweptSessions: state.expiredUnsweptCount,
    r2HighestVerifiedSequence: null,
    r2SqlMetrics: { bytesScanned: 0, filesScanned: 0, queries: 0 },
    receipt: state.receipt,
    sessionMismatches: [],
    verifiedSequence: state.verifiedSequence,
  };
  if (issues.length > 0) return projectResult;

  projectResult.exportIdentities = await verifyExportIdentities(
    state,
    options,
    settings,
    projectResult.r2SqlMetrics,
  );
  if (!projectResult.exportIdentities.match) {
    issues.push(
      `R2 SQL is missing or changed ${
        projectResult.exportIdentities.missing.length +
        projectResult.exportIdentities.mismatched.length
      } required export identity row(s).`,
    );
  }

  const d1RawRows = readAllD1SessionRows(state, options);
  const d1Rows = normalizeAcceptanceRows(d1RawRows, state.projectId, state.verifiedSequence, "D1");
  projectResult.missingSessionExportIds = d1Rows
    .filter((row) => !row.hasSessionExport)
    .map((row) => row.sessionId);
  if (projectResult.missingSessionExportIds.length > 0) {
    issues.push(
      `D1 has ${projectResult.missingSessionExportIds.length} current session(s) without a verified session export.`,
    );
  }

  projectResult.d1HighestVerifiedSequence = readD1HighestSequence(state, options);
  const r2Result = await readAllR2SessionRows(state, options.pageSize, settings);
  addR2Metrics(projectResult.r2SqlMetrics, r2Result.metrics);
  const r2Rows = normalizeAcceptanceRows(
    r2Result.rows,
    state.projectId,
    state.verifiedSequence,
    "R2 SQL",
  );
  const r2Highest = await runR2Sql(
    settings,
    state.projectId,
    buildR2HighestSequenceSql(state.projectId, state.verifiedSequence),
  );
  addR2Metrics(projectResult.r2SqlMetrics, r2Highest);
  projectResult.r2HighestVerifiedSequence = readHighestSequence(r2Highest.rows, "R2 SQL");

  if (projectResult.d1HighestVerifiedSequence !== state.verifiedSequence) {
    issues.push(
      `D1 export identities stop at ${projectResult.d1HighestVerifiedSequence}, but the warehouse state is ${state.verifiedSequence}.`,
    );
  }
  if (projectResult.r2HighestVerifiedSequence !== state.verifiedSequence) {
    issues.push(
      `R2 SQL export identities stop at ${projectResult.r2HighestVerifiedSequence}, but the warehouse state is ${state.verifiedSequence}.`,
    );
  }

  const comparison = compareAcceptanceRows(d1Rows, r2Rows);
  projectResult.days = comparison.days;
  projectResult.sessionMismatches = comparison.sessionMismatches;
  const finalProjectRows = queryD1Rows(
    buildAcceptanceProjectsSql([state.projectId], sourceCutoffMs),
    options,
  );
  const finalState = finalProjectRows.length === 1 ? readProjectState(finalProjectRows[0]) : null;
  if (finalState === null || projectStateKey(finalState) !== projectStateKey(state)) {
    issues.push(
      "The D1 project, receipt, deletion count, or verified sequence changed during the check.",
    );
  }
  const finalD1Rows = normalizeAcceptanceRows(
    readAllD1SessionRows(state, options),
    state.projectId,
    state.verifiedSequence,
    "D1 readback",
  );
  if (JSON.stringify(finalD1Rows) !== JSON.stringify(d1Rows)) {
    issues.push("The current D1 session set changed during the check.");
  }

  projectResult.match = comparison.match && issues.length === 0;
  return projectResult;
}

async function verifyExportIdentities(state, options, settings, metrics) {
  const expected = [];
  const actual = [];
  let afterExportId = "";
  let afterSequence = 0;
  for (;;) {
    const rawPage = queryD1Rows(
      buildD1ExportIdentityPageSql({
        afterExportId,
        afterSequence,
        pageSize: 90,
        projectId: state.projectId,
        warehouseVersion: state.verifiedSequence,
      }),
      options,
    );
    const expectedPage = normalizeExportIdentities(
      rawPage,
      state.projectId,
      state.verifiedSequence,
      "D1",
    );
    expected.push(...expectedPage);
    if (expectedPage.length > 0) {
      const result = await runR2Sql(
        settings,
        state.projectId,
        buildR2ExportIdentityQuery({
          identities: expectedPage,
          projectId: state.projectId,
          warehouseVersion: state.verifiedSequence,
        }),
      );
      addR2Metrics(metrics, result);
      actual.push(
        ...normalizeExportIdentities(
          result.rows,
          state.projectId,
          state.verifiedSequence,
          "R2 SQL",
        ),
      );
    }
    if (rawPage.length < 90) break;
    const last = expectedPage.at(-1);
    if (
      last === undefined ||
      (last.exportSequence === afterSequence && last.exportId === afterExportId)
    ) {
      throw new Error(`D1 export identity paging stopped for project ${state.projectId}.`);
    }
    afterSequence = last.exportSequence;
    afterExportId = last.exportId;
  }
  return compareExportIdentities(expected, actual);
}

function readAllD1SessionRows(state, options) {
  const rows = [];
  let afterSessionId = "";
  for (;;) {
    const page = queryD1Rows(
      buildD1SessionPageSql({
        afterSessionId,
        pageSize: options.pageSize,
        projectId: state.projectId,
        warehouseVersion: state.verifiedSequence,
      }),
      options,
    );
    rows.push(...page);
    if (page.length < options.pageSize) break;
    const nextCursor = String(page.at(-1)?.session_id ?? "");
    if (nextCursor.length === 0 || nextCursor === afterSessionId) {
      throw new Error(`D1 session paging stopped for project ${state.projectId}.`);
    }
    afterSessionId = nextCursor;
  }
  return rows;
}

async function readAllR2SessionRows(state, pageSize, settings) {
  const rows = [];
  const metrics = { bytesScanned: 0, filesScanned: 0, queries: 0 };
  let afterSessionId = "";
  for (;;) {
    const result = await runR2Sql(
      settings,
      state.projectId,
      buildR2SessionPageSql({
        afterSessionId,
        pageSize,
        projectId: state.projectId,
        warehouseVersion: state.verifiedSequence,
      }),
    );
    addR2Metrics(metrics, result);
    rows.push(...result.rows);
    if (result.rows.length < pageSize) break;
    const nextCursor = String(result.rows.at(-1)?.session_id ?? "");
    if (nextCursor.length === 0 || nextCursor === afterSessionId) {
      throw new Error(`R2 SQL session paging stopped for project ${state.projectId}.`);
    }
    afterSessionId = nextCursor;
  }
  return { metrics, rows };
}

function readD1HighestSequence(state, options) {
  const rows = queryD1Rows(
    buildD1HighestSequenceSql(state.projectId, state.verifiedSequence),
    options,
  );
  return readHighestSequence(rows, "D1");
}

function readHighestSequence(rows, label) {
  if (rows.length !== 1) throw new Error(`${label} returned an invalid sequence result.`);
  return readWholeNumber(rows[0]?.highest_verified_sequence, `${label} highest sequence`);
}

function readProjectState(row) {
  const projectId = String(row.project_id ?? "");
  const issues = [];
  let verifiedSequence = 0;
  let deletionCount = 0;
  let expiredUnsweptCount = 0;
  try {
    verifiedSequence = readWholeNumber(row.verified_sequence, "verified sequence");
    deletionCount = readWholeNumber(row.deletion_count, "deletion count");
    expiredUnsweptCount = readWholeNumber(
      row.expired_unswept_count,
      "expired unswept session count",
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const receipt = {
    completedAt: readOptionalWholeNumber(row.completed_at),
    reportId: typeof row.report_id === "string" ? row.report_id : null,
    requiredSequence: readOptionalWholeNumber(row.required_sequence),
    sourceCutoffMs: readOptionalWholeNumber(row.source_cutoff_ms),
    sourceSessionCount: readOptionalWholeNumber(row.source_session_count),
  };
  if (
    receipt.completedAt === null ||
    receipt.completedAt <= 0 ||
    receipt.reportId === null ||
    receipt.reportId.length === 0 ||
    receipt.requiredSequence === null ||
    receipt.sourceCutoffMs === null ||
    receipt.sourceCutoffMs <= 0 ||
    receipt.sourceSessionCount === null
  ) {
    issues.push("The project has no valid backfill completion receipt.");
  } else if (verifiedSequence < receipt.requiredSequence) {
    issues.push(
      `Pipeline visibility is only ${verifiedSequence}; the backfill needs ${receipt.requiredSequence}.`,
    );
  }
  if (expiredUnsweptCount > 0) {
    issues.push(
      `D1 still has ${expiredUnsweptCount} expired session(s) without a deletion marker. Run the retention sweep before cutover.`,
    );
  }
  return {
    deletionCount,
    expiredUnsweptCount,
    issues,
    projectId,
    receipt,
    verifiedSequence,
  };
}

function projectStateKey(state) {
  return JSON.stringify({
    deletionCount: state.deletionCount,
    expiredUnsweptCount: state.expiredUnsweptCount,
    projectId: state.projectId,
    receipt: state.receipt,
    verifiedSequence: state.verifiedSequence,
  });
}

function readOptionalWholeNumber(value) {
  if (value === null || value === undefined) return null;
  try {
    return readWholeNumber(value, "receipt value");
  } catch {
    return null;
  }
}

async function runR2Sql(settings, projectId, sql) {
  assertReadOnlySql(sql);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let response;
  let body;
  try {
    response = await fetch(
      `https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(settings.accountId)}/r2-sql/query/${encodeURIComponent(settings.bucket)}`,
      {
        body: JSON.stringify({ query: sql }),
        headers: {
          authorization: `Bearer ${settings.token}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      },
    );
    body = await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("R2 SQL took longer than 60 seconds.");
    if (response !== undefined) {
      throw new Error("R2 SQL returned unreadable JSON.", { cause: error });
    }
    throw new Error("R2 SQL could not be reached.", { cause: error });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`R2 SQL returned HTTP ${response.status}.`);
  return readR2SqlResponse(body, projectId);
}

async function verifyD1Schema(options) {
  const required = new Map([
    ["projects", ["id", "jurisdiction"]],
    [
      "sessions",
      [
        "project_id",
        "session_id",
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
      ],
    ],
    ["session_events", ["project_id", "session_id"]],
    ["session_deletions", ["project_id", "session_id"]],
    [
      "analytics_export_outbox",
      ["export_id", "export_sequence", "project_id", "session_id", "record_kind"],
    ],
    [
      "analytics_export_ledger",
      ["export_id", "export_sequence", "project_id", "session_id", "record_kind"],
    ],
    ["analytics_warehouse_state", ["project_id", "verified_sequence"]],
    [
      "analytics_backfill_completions",
      [
        "project_id",
        "source_session_count",
        "source_cutoff_ms",
        "required_sequence",
        "report_id",
        "completed_at",
      ],
    ],
  ]);
  for (const [table, columns] of required) {
    const rows = queryD1Rows(assertReadOnlySql(`PRAGMA table_info(${table})`), options);
    const present = new Set(rows.map((row) => row.name));
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new Error(`D1 table ${table} is missing: ${missing.join(", ")}.`);
    }
  }
}

function queryD1Rows(sql, options) {
  const result = runD1(sql, options);
  const rows = result.at(-1)?.results;
  if (!Array.isArray(rows)) throw new Error("D1 returned an invalid query result.");
  return rows;
}

function runD1(sql, options) {
  assertReadOnlySql(sql);
  const commandEnvironment = {
    ...process.env,
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_WRITE_LOGS: "false",
  };
  delete commandEnvironment.ORANGE_REPLAY_R2_SQL_READ_TOKEN;
  delete commandEnvironment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN;
  delete commandEnvironment.WRANGLER_R2_SQL_AUTH_TOKEN;
  const args = ["d1", "execute", options.database, "--remote", "--command", sql, "--json"];
  if (options.configPath !== undefined) args.push("--config", options.configPath);
  if (options.wranglerEnvironment !== undefined) args.push("--env", options.wranglerEnvironment);
  const result = spawnSync(
    "vp",
    ["exec", "--filter", "@orange-replay/worker", "--", "wrangler", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: commandEnvironment,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Remote D1 query failed.").trim());
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error("Wrangler returned unreadable D1 JSON.", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => item.success !== true)) {
    throw new Error("Wrangler returned a failed D1 query.");
  }
  return parsed;
}

function readR2Settings(options, resources) {
  const accountId =
    options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.R2_SQL_ACCOUNT_ID ?? "";
  const bucket = options.bucket ?? process.env.R2_SQL_BUCKET ?? resources.bucket ?? "";
  const warehouse = options.warehouse ?? process.env.R2_SQL_WAREHOUSE ?? "";
  const token =
    process.env.ORANGE_REPLAY_R2_SQL_READ_TOKEN ??
    process.env.ORANGE_REPLAY_PROD_R2_SQL_TOKEN ??
    process.env.WRANGLER_R2_SQL_AUTH_TOKEN ??
    "";
  if (!/^[A-Fa-f0-9]{32}$/.test(accountId)) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID or pass --account-id.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(bucket)) {
    throw new Error("Set a valid analytics bucket.");
  }
  const checkedWarehouse =
    warehouse.length === 0
      ? null
      : /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(warehouse)
        ? warehouse
        : undefined;
  if (checkedWarehouse === undefined) throw new Error("R2 SQL warehouse name is invalid.");
  if (token.trim().length === 0) {
    throw new Error("Set ORANGE_REPLAY_R2_SQL_READ_TOKEN with an R2 SQL query token.");
  }
  return { accountId, bucket, token: token.trim(), warehouse: checkedWarehouse };
}

function makeReport(options, settings, outputPath, sourceCutoffMs) {
  return {
    completedAt: null,
    error: null,
    event: "analytics.backfill_acceptance",
    match: false,
    noDataMutation: true,
    projects: [],
    readSources: {
      d1: { database: options.database, remote: true },
      r2Sql: { bucket: settings.bucket, warehouse: settings.warehouse },
    },
    reportId: `analytics_acceptance_${randomUUID()}`,
    reportPath: outputPath,
    sourceCutoffMs,
    startedAt: new Date().toISOString(),
    status: "running",
    totals: {
      d1Sessions: 0,
      expiredUnsweptSessions: 0,
      expectedExportIdentities: 0,
      matchedProjects: 0,
      missingExportIdentities: 0,
      mismatchedProjects: 0,
      projects: 0,
      r2BytesScanned: 0,
      r2FilesScanned: 0,
      r2Queries: 0,
      r2Sessions: 0,
    },
  };
}

function addProjectTotals(totals, project) {
  totals.projects += 1;
  totals.expiredUnsweptSessions += project.expiredUnsweptSessions;
  if (project.match) totals.matchedProjects += 1;
  else totals.mismatchedProjects += 1;
  for (const day of project.days) {
    totals.d1Sessions += day.d1.sessionCount;
    totals.r2Sessions += day.r2.sessionCount;
  }
  totals.expectedExportIdentities += project.exportIdentities.expectedCount;
  totals.missingExportIdentities +=
    project.exportIdentities.missing.length + project.exportIdentities.mismatched.length;
  totals.r2BytesScanned += project.r2SqlMetrics.bytesScanned;
  totals.r2FilesScanned += project.r2SqlMetrics.filesScanned;
  totals.r2Queries += project.r2SqlMetrics.queries;
}

function addR2Metrics(target, result) {
  target.bytesScanned += result.bytesScanned;
  target.filesScanned += result.filesScanned;
  target.queries += result.queries ?? 1;
}

function defaultReportPath() {
  return defaultAcceptanceReportPath(repoRoot);
}

function makeOfflinePlan(pageSize) {
  const input = {
    afterSessionId: "",
    pageSize,
    projectId: "project_example",
    warehouseVersion: 0,
  };
  return {
    event: "analytics.backfill_acceptance.plan",
    networkAccess: false,
    readOnly: true,
    reportsWritten: false,
    sql: {
      d1ExportIdentityPage: buildD1ExportIdentityPageSql({
        afterExportId: "",
        afterSequence: 0,
        pageSize: 90,
        projectId: input.projectId,
        warehouseVersion: input.warehouseVersion,
      }),
      d1HighestSequence: buildD1HighestSequenceSql(input.projectId, input.warehouseVersion),
      d1Projects: buildAcceptanceProjectsSql([], 1_700_000_000_000),
      d1SessionPage: buildD1SessionPageSql(input),
      r2HighestSequence: buildR2HighestSequenceSql(input.projectId, input.warehouseVersion),
      r2IdentityCheck: buildR2ExportIdentityQuery({
        identities: [
          {
            exportId: "session:project_example:session_example",
            recordKind: "session",
          },
        ],
        projectId: input.projectId,
        warehouseVersion: input.warehouseVersion,
      }),
      r2SessionPage: buildR2SessionPageSql(input),
    },
  };
}
