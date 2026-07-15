import { readFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { maintainAnalyticsWarehouse } from "../src/analytics/maintenance.ts";
import type { Env } from "../src/env.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analytics warehouse maintenance", () => {
  it("reconciles healthy projects and reports bad stored data without throwing", async () => {
    const database = await createDatabase();
    seedExport(database, {
      exportId: "session:bad-project:bad-session",
      projectId: "bad-project",
      sessionId: "bad-session",
      payload: sessionPayload("bad-project", "bad-session", "complete"),
    });
    seedExport(database, {
      exportId: "session:healthy-project:healthy-session",
      projectId: "healthy-project",
      sessionId: "healthy-session",
      payload: sessionPayload("healthy-project", "healthy-session", "sparse"),
    });

    const acceptedExportIds: string[] = [];
    const log = vi.spyOn(globalThis.console, "log").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: true,
        result: {
          rows: [
            {
              project_id: "healthy-project",
              export_id: "session:healthy-project:healthy-session",
            },
          ],
          schema: [],
          metrics: { bytes_scanned: 1, files_scanned: 1 },
        },
      }),
    );

    await expect(
      maintainAnalyticsWarehouse({
        ANALYTICS_EXPORT_ENABLED: "1",
        ANALYTICS_READ_BACKEND: "d1",
        ANALYTICS_STREAM: {
          async send(records: readonly Record<string, unknown>[]) {
            acceptedExportIds.push(
              ...records.map((record) =>
                typeof record["export_id"] === "string" ? record["export_id"] : "missing",
              ),
            );
          },
        },
        RECORDINGS: {
          async get() {
            return null;
          },
        },
        IDX_00: database,
        R2_SQL_ACCOUNT_ID: "account",
        R2_SQL_BUCKET: "bucket",
        R2_SQL_TOKEN: "token",
        WORKER_ENV: "test",
      } as unknown as Env),
    ).resolves.toBeUndefined();

    expect(acceptedExportIds).toEqual([
      "session:bad-project:bad-session",
      "session:healthy-project:healthy-session",
    ]);
    expect(
      database.value(
        "SELECT verified_sequence FROM analytics_warehouse_state WHERE project_id = ?",
        "healthy-project",
      ),
    ).toBe(2);
    expect(
      database.row(
        `SELECT sent_at, attempt_count, last_error
        FROM analytics_export_outbox WHERE project_id = ?`,
        "bad-project",
      ),
    ).toMatchObject({
      sent_at: null,
      attempt_count: 1,
      last_error: expect.stringContaining("missing its analytics sidecar"),
    });

    expect(log).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
    const wideEvent = JSON.parse(String(errorLog.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(wideEvent).toMatchObject({
      event: "consumer.analytics_warehouse",
      outcome: "server_error",
      exports_selected: 2,
      exports_sent: 1,
      exports_failed: 1,
      projects_checked: 1,
      projects_failed: 0,
      projects_advanced: 1,
    });
    database.close();
  });
});

type SqlValue = string | number | bigint | Uint8Array | null;

class TestD1Database {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(query: string): TestD1Statement {
    return new TestD1Statement(this.sqlite.prepare(query));
  }

  async batch(statements: readonly TestD1Statement[]): Promise<readonly TestD1Result[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runNow());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  value(query: string, ...values: SqlValue[]): unknown {
    return Object.values(this.sqlite.prepare(query).get(...values) ?? {})[0];
  }

  row(query: string, ...values: SqlValue[]): Record<string, unknown> | undefined {
    return this.sqlite.prepare(query).get(...values);
  }

  close(): void {
    this.sqlite.close();
  }
}

class TestD1Statement {
  private values: SqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: SqlValue[]): TestD1Statement {
    this.values = values;
    return this;
  }

  async all<Row extends Record<string, unknown>>(): Promise<{ results: Row[] }> {
    return { results: this.statement.all(...this.values) as Row[] };
  }

  async first<Row extends Record<string, unknown>>(): Promise<Row | null> {
    return (this.statement.get(...this.values) as Row | undefined) ?? null;
  }

  async run(): Promise<TestD1Result> {
    return this.runNow();
  }

  runNow(): TestD1Result {
    const result = this.statement.run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

interface TestD1Result {
  meta: { changes: number };
}

async function createDatabase(): Promise<TestD1Database> {
  const database = new TestD1Database();
  const migrations = await Promise.all(
    ["0009_analytics_warehouse.sql", "0016_analytics_deletion_started_at.sql"].map(
      async (fileName) => readFile(new URL(`../migrations/${fileName}`, import.meta.url), "utf8"),
    ),
  );
  for (const migration of migrations) database.sqlite.exec(migration);
  database.sqlite.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    jurisdiction TEXT
  )`);
  database.sqlite.exec(`CREATE TABLE session_deletions (
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, session_id)
  )`);
  return database;
}

function seedExport(
  database: TestD1Database,
  input: {
    exportId: string;
    projectId: string;
    sessionId: string;
    payload: Record<string, unknown>;
  },
): void {
  database.sqlite
    .prepare("INSERT OR IGNORE INTO projects (id, jurisdiction) VALUES (?, NULL)")
    .run(input.projectId);
  database.sqlite
    .prepare(
      `INSERT INTO analytics_export_outbox (
        export_id, project_id, session_id, record_kind, payload_json, created_at
      ) VALUES (?, ?, ?, 'session', ?, 1)`,
    )
    .run(input.exportId, input.projectId, input.sessionId, JSON.stringify(input.payload));
}

function sessionPayload(
  projectId: string,
  sessionId: string,
  coverage: "complete" | "sparse",
): Record<string, unknown> {
  return {
    schema_version: 1,
    record_kind: "session",
    export_id: `session:${projectId}:${sessionId}`,
    project_id: projectId,
    session_id: sessionId,
    recorded_at: 200,
    event_coverage: coverage,
    org_id: `org-${projectId}`,
    started_at: 100,
    ended_at: 200,
    duration_ms: 100,
    country: null,
    region: null,
    city: null,
    device: null,
    browser: null,
    os: null,
    entry_url: null,
    url_count: 1,
    page_count: null,
    analytics_version: 0,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    activity_hist: null,
    clicks: 0,
    event_count: coverage === "complete" ? 1 : 0,
    errors: 0,
    rages: 0,
    navs: 0,
    bytes: 1,
    segment_count: 1,
    flags: 0,
    manifest_key: `p/${projectId}/${sessionId}/manifest.json`,
    analytics_sidecar_key:
      coverage === "complete" ? `p/${projectId}/${sessionId}/analytics.ndjson` : null,
    expires_at: 300,
  };
}
