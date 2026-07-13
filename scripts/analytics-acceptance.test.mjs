import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
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
  writePrivateJsonReport,
} from "./analytics/acceptance-lib.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDirectory, "..");

describe("analytics backfill acceptance", () => {
  it("keeps the real check remote and does not accept a token argument", () => {
    expect(() => parseAcceptanceArguments([])).toThrow("--database");
    expect(parseAcceptanceArguments(["--offline"])).toMatchObject({
      offline: true,
      pageSize: 1_000,
    });
    expect(() =>
      parseAcceptanceArguments(["--database", "orange-replay-prod", "--token", "secret"]),
    ).toThrow("Unknown analytics verification option: --token");
    expect(
      parseAcceptanceArguments([
        "--database",
        "orange-replay-prod",
        "--project",
        "project_2",
        "--project",
        "project_1",
        "--project",
        "project_2",
        "--page-size",
        "5000",
      ]),
    ).toMatchObject({
      database: "orange-replay-prod",
      pageSize: 5_000,
      projectIds: ["project_1", "project_2"],
    });
  });

  it("builds only read-only D1 and R2 SQL at one verified version", () => {
    const input = {
      afterSessionId: "session_1",
      pageSize: 100,
      projectId: "project_1",
      warehouseVersion: 44,
    };
    const r2SessionPage = buildR2SessionPageSql(input);
    const r2SessionIdentity = buildR2ExportIdentityQuery({
      identities: [
        {
          exportId: "session:project_1:session_1",
          recordKind: "session",
        },
      ],
      projectId: input.projectId,
      warehouseVersion: input.warehouseVersion,
    });
    const r2EventIdentity = buildR2ExportIdentityQuery({
      identities: [
        {
          exportId: "event:project_1:session_1:0:100:error",
          recordKind: "event",
        },
      ],
      projectId: input.projectId,
      warehouseVersion: input.warehouseVersion,
    });
    const r2DeletionIdentity = buildR2ExportIdentityQuery({
      identities: [
        {
          exportId: "deletion:project_1:session_1",
          recordKind: "deletion",
        },
      ],
      projectId: input.projectId,
      warehouseVersion: input.warehouseVersion,
    });
    const queries = [
      buildAcceptanceProjectsSql([input.projectId]),
      buildD1SessionPageSql(input),
      buildD1ExportIdentityPageSql({
        afterExportId: "",
        afterSequence: 0,
        pageSize: 90,
        projectId: input.projectId,
        warehouseVersion: input.warehouseVersion,
      }),
      buildD1HighestSequenceSql(input.projectId, input.warehouseVersion),
      r2SessionPage,
      buildR2HighestSequenceSql(input.projectId, input.warehouseVersion),
      r2SessionIdentity,
    ];
    for (const query of queries) {
      expect(assertReadOnlySql(query)).toBe(query);
      expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
    }
    expect(queries[1]).toContain("analytics_export_ledger");
    expect(queries[1]).toContain("session_events");
    expect(queries[1]).toContain("has_session_export");
    for (const field of [
      "duration_ms",
      "page_count",
      "country",
      "region",
      "city",
      "device",
      "browser",
      "os",
      "entry_url",
      "max_scroll_depth",
      "quick_backs",
      "interaction_time_ms",
      "activity_hist",
    ]) {
      expect(queries[1]).toContain(`session.${field}`);
      expect(r2SessionPage).toContain(`session.${field}`);
    }
    expect(r2SessionPage).toContain("export_sequence <= 44");
    expect(r2SessionPage).toContain("event_coverage = 'sparse'");
    expect(r2SessionPage).toContain("AND session.session_id > 'session_1'");
    expect(r2SessionPage).toContain("paged_sessions AS");
    expect(r2SessionPage).toContain("NOT EXISTS");
    expect(r2SessionPage).toContain("FROM deleted_sessions deletion");
    expect(r2SessionPage).not.toContain("LEFT JOIN deleted_sessions deletion");
    expect(r2SessionPage).not.toContain("session.*");
    expect(r2SessionIdentity).toContain('FROM "default"."analytics_sessions"');
    expect(r2SessionIdentity).not.toContain('FROM "default"."analytics_events"');
    expect(r2SessionIdentity).toContain("record_kind = 'session'");
    expect(r2SessionIdentity).toContain("event_coverage IN ('sparse', 'complete')");
    expect(r2SessionIdentity).toContain("event_count IS NOT NULL");
    expect(r2EventIdentity).toContain("record_kind = 'event'");
    expect(r2EventIdentity).not.toContain("event_coverage");
    expect(r2EventIdentity).toContain("event_index IS NOT NULL");
    expect(r2DeletionIdentity).toContain("record_kind = 'deletion'");
    expect(r2DeletionIdentity).not.toContain("event_coverage");
    expect(r2DeletionIdentity).toContain("deleted_at IS NOT NULL");
    expect(r2DeletionIdentity).toContain("delete_reason IS NOT NULL");
    expect(() => assertReadOnlySql("UPDATE sessions SET clicks = 0")).toThrow("read-only");
  });

  it("uses only fields that each committed Pipeline table stores", async () => {
    const pipelineSql = await readFile(
      path.join(repoRoot, "infra", "analytics", "pipeline.sql"),
      "utf8",
    );
    const cases = [
      {
        exportId: "session:project_1:session_1",
        fields: [
          "project_id",
          "export_id",
          "export_sequence",
          "session_id",
          "record_kind",
          "schema_version",
          "recorded_at",
          "event_coverage",
          "org_id",
          "started_at",
          "ended_at",
          "duration_ms",
          "url_count",
          "analytics_version",
          "clicks",
          "event_count",
          "errors",
          "rages",
          "navs",
          "bytes",
          "segment_count",
          "flags",
          "manifest_key",
          "analytics_sidecar_key",
          "expires_at",
        ],
        kind: "session",
        sink: "orange_replay_analytics_sessions_sink",
      },
      {
        exportId: "event:project_1:session_1:0:100:error",
        fields: [
          "project_id",
          "export_id",
          "export_sequence",
          "session_id",
          "record_kind",
          "schema_version",
          "recorded_at",
          "event_index",
          "event_time",
          "event_kind",
        ],
        kind: "event",
        sink: "orange_replay_analytics_events_sink",
      },
      {
        exportId: "deletion:project_1:session_1",
        fields: [
          "project_id",
          "export_id",
          "export_sequence",
          "session_id",
          "record_kind",
          "schema_version",
          "recorded_at",
          "deleted_at",
          "delete_reason",
        ],
        kind: "deletion",
        sink: "orange_replay_analytics_deletions_sink",
      },
    ];

    for (const item of cases) {
      const projection = readPipelineProjection(pipelineSql, item.sink);
      const query = buildR2ExportIdentityQuery({
        identities: [{ exportId: item.exportId, recordKind: item.kind }],
        projectId: "project_1",
        warehouseVersion: 44,
      });

      for (const field of item.fields) {
        expect(projection, `${item.kind} Pipeline projection`).toContain(field);
        expect(query, `${item.kind} identity query`).toContain(field);
      }
      if (item.kind !== "session") {
        expect(projection).not.toContain("event_coverage");
        expect(query).not.toContain("event_coverage");
      }
    }
  });

  it("starts from every current D1 session and counts only sparse exported events", () => {
    const database = createD1Fixture();
    try {
      const rows = database
        .prepare(
          buildD1SessionPageSql({
            afterSessionId: "",
            pageSize: 100,
            projectId: "project_1",
            warehouseVersion: 4,
          }),
        )
        .all();

      expect(rows.map((row) => row.session_id)).toEqual([
        "session_complete",
        "session_exported",
        "session_missing",
      ]);
      expect(rows[0]).toMatchObject({
        has_session_export: 1,
        highest_sequence: 3,
        sparse_event_count: 0,
      });
      expect(rows[1]).toMatchObject({
        has_session_export: 1,
        highest_sequence: 2,
        sparse_event_count: 2,
      });
      expect(rows[2]).toMatchObject({
        has_session_export: 0,
        highest_sequence: 0,
        sparse_event_count: 0,
      });
      expect(
        database.prepare(buildD1HighestSequenceSql("project_1", 4)).get().highest_verified_sequence,
      ).toBe(4);
      expect(
        database
          .prepare(
            buildD1ExportIdentityPageSql({
              afterExportId: "",
              afterSequence: 0,
              pageSize: 90,
              projectId: "project_1",
              warehouseVersion: 4,
            }),
          )
          .all()
          .map((row) => row.export_sequence),
      ).toEqual([1, 2, 3, 4]);
    } finally {
      database.close();
    }
  });

  it("finds export-id holes even when both sides have the same highest sequence", () => {
    const expected = normalizeExportIdentities(
      [1, 2, 3].map((sequence) => exportIdentityRow(sequence)),
      "project_1",
      3,
      "D1",
    );
    const actual = normalizeExportIdentities([exportIdentityRow(3)], "project_1", 3, "R2 SQL");
    const comparison = compareExportIdentities(expected, actual);

    expect(Math.max(...expected.map((row) => row.exportSequence))).toBe(3);
    expect(Math.max(...actual.map((row) => row.exportSequence))).toBe(3);
    expect(comparison.match).toBe(false);
    expect(comparison.missing.map((row) => row.exportSequence)).toEqual([1, 2]);
  });

  it("compares exact ids and every required per-day aggregate", () => {
    const d1Rows = [
      acceptanceRow("session_2", "2026-07-13T09:00:00.000Z", {
        bytes: 20,
        clicks: 2,
        errors: 1,
        highestSequence: 9,
        rages: 1,
        sparseEventCount: 3,
      }),
      acceptanceRow("session_1", "2026-07-13T08:00:00.000Z", {
        bytes: 10,
        clicks: 1,
        errors: 0,
        highestSequence: 4,
        rages: 0,
        sparseEventCount: 1,
      }),
    ];
    const matching = compareAcceptanceRows(d1Rows, [...d1Rows].reverse());
    expect(matching).toEqual({
      days: [
        {
          day: "2026-07-13",
          d1: {
            bytes: 30,
            clicks: 3,
            errors: 1,
            highestSequence: 9,
            rages: 1,
            sessionCount: 2,
            sessionIds: ["session_1", "session_2"],
            sparseEventCount: 4,
          },
          match: true,
          mismatches: [],
          r2: {
            bytes: 30,
            clicks: 3,
            errors: 1,
            highestSequence: 9,
            rages: 1,
            sessionCount: 2,
            sessionIds: ["session_1", "session_2"],
            sparseEventCount: 4,
          },
        },
      ],
      match: true,
      sessionMismatches: [],
    });

    const mismatched = compareAcceptanceRows(d1Rows, [
      { ...d1Rows[0], bytes: 21, errors: 2, sparseEventCount: 2 },
    ]);
    expect(mismatched.match).toBe(false);
    expect(mismatched.days[0]?.mismatches.map((item) => item.field)).toEqual([
      "sessionIds",
      "sessionCount",
      "bytes",
      "clicks",
      "errors",
      "sparseEventCount",
    ]);
    expect(mismatched.sessionMismatches.map((item) => item.field)).toEqual([
      "bytes",
      "errors",
      "sparseEventCount",
    ]);
  });

  it("fails when a dashboard session value differs even if the totals still match", () => {
    const d1 = acceptanceRow("session_1", "2026-07-13T08:00:00.000Z", {
      browser: "Chrome",
      durationMs: 10_000,
      entryUrl: "https://example.com/start",
      maxScrollDepth: 80,
      pageCount: 2,
    });
    const r2 = {
      ...d1,
      browser: "Firefox",
      durationMs: 9_000,
      entryUrl: "https://example.com/other",
      maxScrollDepth: 20,
      pageCount: 1,
    };

    const comparison = compareAcceptanceRows([d1], [r2]);
    expect(comparison.days[0]?.match).toBe(true);
    expect(comparison.match).toBe(false);
    expect(comparison.sessionMismatches.map((item) => item.field)).toEqual([
      "browser",
      "durationMs",
      "entryUrl",
      "maxScrollDepth",
      "pageCount",
    ]);
  });

  it("checks R2 SQL response shape and project isolation", () => {
    const body = r2Response([
      {
        project_id: "project_1",
        session_id: "session_1",
      },
    ]);
    expect(readR2SqlResponse(body, "project_1")).toMatchObject({
      bytesScanned: 10,
      filesScanned: 1,
    });
    expect(() => readR2SqlResponse(body, "project_2")).toThrow("wrong project");
    expect(() => readR2SqlResponse({ success: true }, "project_1")).toThrow("invalid answer");
  });

  it("normalizes integer strings but rejects duplicates and rows after the snapshot", () => {
    const raw = {
      ...rawAcceptanceRow(),
      bytes: "10",
      has_session_export: 0,
      highest_sequence: 3,
      sparse_event_count: 2,
    };
    expect(normalizeAcceptanceRows([raw], "project_1", 3, "D1")[0]).toMatchObject({
      bytes: 10,
      hasSessionExport: false,
    });
    expect(() => normalizeAcceptanceRows([raw, raw], "project_1", 3, "D1")).toThrow("twice");
    expect(() =>
      normalizeAcceptanceRows([{ ...raw, highest_sequence: 4 }], "project_1", 3, "D1"),
    ).toThrow("after the warehouse version");
  });

  it("reports expired source sessions that the retention sweep has not removed", () => {
    const database = createD1Fixture();
    try {
      database.exec(`
        UPDATE sessions SET expires_at = 999
        WHERE session_id IN ('session_missing', 'session_deleted');
      `);
      const project = database.prepare(buildAcceptanceProjectsSql(["project_1"], 1_000)).get();

      expect(project?.expired_unswept_count).toBe(1);
    } finally {
      database.close();
    }
  });

  it("writes a timestamped private JSON artifact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "orange-replay-acceptance-"));
    try {
      const reportPath = defaultAcceptanceReportPath(
        directory,
        new Date("2026-07-13T12:34:56.789Z"),
      );
      await writePrivateJsonReport(reportPath, { match: true });

      expect(reportPath).toContain("production-2026-07-13T12-34-56.789Z.json");
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual({ match: true });
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("has an offline syntax plan that does not contact Cloudflare or write a report", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-analytics-backfill.mjs", "--offline"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      event: "analytics.backfill_acceptance.plan",
      networkAccess: false,
      readOnly: true,
      reportsWritten: false,
    });
  });

  it("hardcodes remote D1 and has no completion or mutation path", async () => {
    const source = await readFile(
      path.join(scriptsDirectory, "verify-analytics-backfill.mjs"),
      "utf8",
    );
    expect(source).toContain('"--remote"');
    expect(source).not.toContain('"--local"');
    expect(source).not.toContain('"--apply"');
    expect(source).not.toMatch(
      /\b(INSERT INTO|UPDATE .* SET|DELETE FROM|DROP TABLE|ALTER TABLE)\b/i,
    );
    expect(source).not.toContain("analytics_backfill_completions (");
  });
});

function readPipelineProjection(sql, sink) {
  const match = new RegExp(`INSERT INTO ${sink}\\s+SELECT([\\s\\S]*?)\\s+FROM\\s+`, "m").exec(sql);
  if (match?.[1] === undefined) throw new Error(`Pipeline sink ${sink} has no SELECT projection.`);
  return match[1]
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
}

function createD1Fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      jurisdiction TEXT
    );
    CREATE TABLE sessions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'org_1',
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      country TEXT DEFAULT 'US',
      region TEXT DEFAULT 'CA',
      city TEXT DEFAULT 'San Francisco',
      device TEXT DEFAULT 'desktop',
      browser TEXT DEFAULT 'Chrome',
      os TEXT DEFAULT 'macOS',
      entry_url TEXT DEFAULT 'https://example.com/',
      url_count INTEGER NOT NULL DEFAULT 1,
      page_count INTEGER DEFAULT 1,
      analytics_version INTEGER NOT NULL DEFAULT 1,
      max_scroll_depth INTEGER DEFAULT 50,
      quick_backs INTEGER DEFAULT 0,
      interaction_time_ms INTEGER DEFAULT 100,
      activity_hist TEXT DEFAULT '1,0,0',
      bytes INTEGER NOT NULL,
      clicks INTEGER NOT NULL,
      errors INTEGER NOT NULL,
      rages INTEGER NOT NULL,
      navs INTEGER NOT NULL DEFAULT 0,
      segment_count INTEGER NOT NULL DEFAULT 1,
      flags INTEGER NOT NULL DEFAULT 0,
      manifest_key TEXT NOT NULL DEFAULT 'p/project_1/session/manifest.json',
      expires_at INTEGER NOT NULL DEFAULT 2000000000000,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE session_events (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      t INTEGER NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id, t, kind)
    );
    CREATE TABLE session_deletions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE analytics_export_outbox (
      export_id TEXT PRIMARY KEY,
      export_sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      record_kind TEXT NOT NULL
    );
    CREATE TABLE analytics_export_ledger (
      export_id TEXT PRIMARY KEY,
      export_sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      record_kind TEXT NOT NULL
    );
    CREATE TABLE analytics_warehouse_state (
      project_id TEXT PRIMARY KEY,
      verified_sequence INTEGER NOT NULL,
      verified_at INTEGER
    );
    CREATE TABLE analytics_backfill_completions (
      project_id TEXT PRIMARY KEY,
      source_session_count INTEGER NOT NULL,
      source_cutoff_ms INTEGER NOT NULL,
      required_sequence INTEGER NOT NULL,
      report_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );

    INSERT INTO projects VALUES ('project_1', NULL);
    INSERT INTO sessions (project_id, session_id, started_at, bytes, clicks, errors, rages) VALUES
      ('project_1', 'session_exported', 1000, 10, 2, 1, 0),
      ('project_1', 'session_missing', 2000, 20, 3, 0, 1),
      ('project_1', 'session_deleted', 3000, 30, 4, 1, 1),
      ('project_1', 'session_complete', 4000, 40, 5, 0, 0);
    INSERT INTO session_events VALUES
      ('project_1', 'session_exported', 1, 'error'),
      ('project_1', 'session_exported', 2, 'custom'),
      ('project_1', 'session_missing', 3, 'error'),
      ('project_1', 'session_complete', 4, 'custom');
    INSERT INTO analytics_export_outbox VALUES
      ('session:project_1:session_exported', 1, 'project_1', 'session_exported', 'session'),
      ('event:project_1:session_exported:0', 2, 'project_1', 'session_exported', 'event'),
      ('session:project_1:session_complete', 3, 'project_1', 'session_complete', 'session'),
      ('session:project_1:session_deleted', 4, 'project_1', 'session_deleted', 'session');
    INSERT INTO session_deletions VALUES ('project_1', 'session_deleted');
  `);
  return database;
}

function acceptanceRow(sessionId, startedAt, overrides) {
  return {
    activityHist: "1,0,0",
    analyticsVersion: 1,
    browser: "Chrome",
    bytes: 0,
    city: "San Francisco",
    clicks: 0,
    country: "US",
    device: "desktop",
    durationMs: 1_000,
    endedAt: Date.parse(startedAt) + 1_000,
    entryUrl: "https://example.com/",
    errors: 0,
    expiresAt: 2_000_000_000_000,
    flags: 0,
    hasSessionExport: true,
    highestSequence: 0,
    interactionTimeMs: 500,
    manifestKey: `p/project_1/${sessionId}/manifest.json`,
    maxScrollDepth: 50,
    navs: 0,
    orgId: "org_1",
    os: "macOS",
    pageCount: 1,
    projectId: "project_1",
    quickBacks: 0,
    rages: 0,
    region: "CA",
    segmentCount: 1,
    sessionId,
    sparseEventCount: 0,
    startedAt: Date.parse(startedAt),
    urlCount: 1,
    ...overrides,
  };
}

function rawAcceptanceRow() {
  return {
    activity_hist: "1,0,0",
    analytics_version: 1,
    browser: "Chrome",
    bytes: 10,
    city: "San Francisco",
    clicks: 1,
    country: "US",
    device: "desktop",
    duration_ms: 1_000,
    ended_at: Date.parse("2026-07-13T00:00:01.000Z"),
    entry_url: "https://example.com/",
    errors: 0,
    expires_at: 2_000_000_000_000,
    flags: 0,
    has_session_export: 1,
    highest_sequence: 3,
    interaction_time_ms: 500,
    manifest_key: "p/project_1/session_1/manifest.json",
    max_scroll_depth: 50,
    navs: 0,
    org_id: "org_1",
    os: "macOS",
    page_count: 1,
    project_id: "project_1",
    quick_backs: 0,
    rages: 0,
    region: "CA",
    segment_count: 1,
    session_id: "session_1",
    sparse_event_count: 0,
    started_at: Date.parse("2026-07-13T00:00:00.000Z"),
    url_count: 1,
  };
}

function exportIdentityRow(sequence) {
  return {
    export_id: `session:project_1:session_${sequence}`,
    export_sequence: sequence,
    project_id: "project_1",
    record_kind: "session",
    session_id: `session_${sequence}`,
  };
}

function r2Response(rows) {
  return {
    result: {
      metrics: { bytes_scanned: 10, files_scanned: 1 },
      rows,
      schema: [],
    },
    success: true,
  };
}
