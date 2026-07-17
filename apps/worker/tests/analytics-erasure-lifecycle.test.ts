import { readFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import {
  ANALYTICS_PURGE_QUIET_MS,
  claimAnalyticsPurgeJobs,
  queueDeletionExportsFromJournal,
  recordAnalyticsErasureRequests,
  reportAnalyticsPurgeResults,
} from "../src/analytics/erasure-lifecycle.ts";
import {
  deletionV2ExportId,
  maintainAnalyticsDeletionV2,
  type AnalyticsDeletionV2Record,
} from "../src/analytics/deletion-v2.ts";

const PROJECT_ID = "project";
const SESSION_ID = "session";
const REQUESTED_AT = 1_000;

describe("analytics erasure lifecycle", () => {
  it("records requests atomically and keeps the durable request fields stable", async () => {
    const database = await createLifecycleDatabase();
    const db = lifecycleDatabase(database);

    await recordAnalyticsErasureRequests(
      db,
      [erasureRequest({ startedAt: 500, requiresWarehouseTombstone: 0 })],
      2_000,
    );
    database.run(
      `UPDATE analytics_deletion_jobs SET completed_at = 2_500
      WHERE project_id = ? AND session_id = ?`,
      PROJECT_ID,
      SESSION_ID,
    );
    await recordAnalyticsErasureRequests(
      db,
      [
        erasureRequest({
          startedAt: 400,
          deleteReason: "delete_requested",
          requiresWarehouseTombstone: 1,
        }),
      ],
      1_000,
    );
    await recordAnalyticsErasureRequests(
      db,
      [erasureRequest({ startedAt: 300, requiresWarehouseTombstone: 0 })],
      3_000,
    );

    expect(
      database.row(
        `SELECT requested_at, delete_reason, session_started_at,
          requires_warehouse_tombstone, completed_at
        FROM analytics_deletion_jobs`,
      ),
    ).toEqual({
      completed_at: null,
      delete_reason: "retention_expired",
      requested_at: 1_000,
      requires_warehouse_tombstone: 1,
      session_started_at: 500,
    });

    database.run(
      `INSERT INTO analytics_export_outbox (
        export_id, project_id, session_id, record_kind, payload_json, created_at
      ) VALUES ('session:rollback:session', 'rollback', 'session', 'session', '{}', 1)`,
    );
    database.run(
      `CREATE TRIGGER stop_erasure_cleanup
      BEFORE DELETE ON analytics_export_outbox
      WHEN OLD.project_id = 'rollback'
      BEGIN
        SELECT RAISE(ABORT, 'cleanup stopped');
      END`,
    );

    await expect(
      recordAnalyticsErasureRequests(
        db,
        [
          {
            projectId: "rollback",
            sessionId: "session",
            startedAt: 500,
            deleteReason: "delete_requested",
            requiresWarehouseTombstone: 1,
          },
        ],
        4_000,
      ),
    ).rejects.toThrow("cleanup stopped");
    expect(
      database.value(
        `SELECT COUNT(*) FROM session_deletions
        WHERE project_id = 'rollback' AND session_id = 'session'`,
      ),
    ).toBe(0);
    expect(
      database.value(
        `SELECT COUNT(*) FROM analytics_deletion_jobs
        WHERE project_id = 'rollback' AND session_id = 'session'`,
      ),
    ).toBe(0);
    expect(
      database.value(
        `SELECT COUNT(*) FROM analytics_export_outbox
        WHERE project_id = 'rollback' AND session_id = 'session'`,
      ),
    ).toBe(1);
    database.close();
  });

  it("completes physical deletion before v2 visibility without losing v2 work", async () => {
    const database = await createLifecycleDatabase();
    const db = lifecycleDatabase(database);
    await recordAnalyticsErasureRequests(
      db,
      [
        erasureRequest({
          startedAt: 500,
          deleteReason: "delete_requested",
          requiresWarehouseTombstone: 1,
        }),
      ],
      REQUESTED_AT,
    );

    await expect(queueDeletionExportsFromJournal(db, REQUESTED_AT + 1)).resolves.toBe(1);
    const exportSequence = database.value(
      `SELECT deletion_export_sequence FROM analytics_deletion_jobs
      WHERE project_id = ? AND session_id = ?`,
      PROJECT_ID,
      SESSION_ID,
    );
    expect(exportSequence).toBe(1);
    expect(
      database.row(
        `SELECT export_id, export_sequence FROM analytics_export_outbox
        WHERE project_id = ? AND session_id = ? AND record_kind = 'deletion'`,
        PROJECT_ID,
        SESSION_ID,
      ),
    ).toEqual({ export_id: "deletion:project:session", export_sequence: 1 });
    database.run(
      `INSERT INTO analytics_warehouse_state (project_id, verified_sequence)
      VALUES (?, ?)`,
      PROJECT_ID,
      Number(exportSequence),
    );

    const firstCheckAt = REQUESTED_AT + ANALYTICS_PURGE_QUIET_MS;
    const firstClaim = await claimAnalyticsPurgeJobs(db, "runner-first", firstCheckAt, 1);
    expect(firstClaim.jobs).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        needsPhysicalMaintenance: true,
      }),
    ]);
    await expect(
      claimAnalyticsPurgeJobs(db, "runner-busy", firstCheckAt, 1),
    ).resolves.toMatchObject({ jobs: [] });
    await expect(
      reportAnalyticsPurgeResults(
        db,
        "runner-first",
        [
          {
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            rowsRemaining: 0,
            rowsFoundBefore: 0,
          },
        ],
        firstCheckAt,
      ),
    ).resolves.toEqual({ completed: 0, waitingForSecondCheck: 1, failed: 0 });

    await expect(
      claimAnalyticsPurgeJobs(db, "runner-early", firstCheckAt + ANALYTICS_PURGE_QUIET_MS - 1, 1),
    ).resolves.toMatchObject({ jobs: [] });
    const secondCheckAt = firstCheckAt + ANALYTICS_PURGE_QUIET_MS;
    const secondClaim = await claimAnalyticsPurgeJobs(db, "runner-second", secondCheckAt, 1);
    expect(secondClaim.jobs).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        needsPhysicalMaintenance: false,
      }),
    ]);
    await expect(
      reportAnalyticsPurgeResults(
        db,
        "runner-second",
        [
          {
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            rowsRemaining: 0,
            rowsFoundBefore: 0,
          },
        ],
        secondCheckAt,
      ),
    ).resolves.toEqual({ completed: 1, waitingForSecondCheck: 0, failed: 0 });
    expect(database.value("SELECT completed_at FROM analytics_deletion_jobs")).toBe(secondCheckAt);

    const accepted: AnalyticsDeletionV2Record[] = [];
    const visibleIds = new Set<string>();
    const pipeline = {
      async send(records: readonly Record<string, unknown>[]) {
        accepted.push(...(records as AnalyticsDeletionV2Record[]));
      },
    };
    const visibility = {
      async findVisibleExportIds(input: { records: readonly AnalyticsDeletionV2Record[] }) {
        return input.records
          .map((record) => record.export_id)
          .filter((exportId) => visibleIds.has(exportId));
      },
      async proveTableExists() {},
    };
    const v2SentAt = secondCheckAt + 1;

    await expect(
      maintainAnalyticsDeletionV2(db, pipeline, visibility, { now: v2SentAt }),
    ).resolves.toMatchObject({ ready: false, selected: 1, sent: 1, visibleJobs: 0 });
    expect(accepted).toEqual([
      expect.objectContaining({
        export_id: deletionV2ExportId(PROJECT_ID, SESSION_ID),
        session_id: SESSION_ID,
      }),
    ]);
    visibleIds.add(deletionV2ExportId(PROJECT_ID, SESSION_ID));
    await expect(
      maintainAnalyticsDeletionV2(db, pipeline, visibility, {
        now: v2SentAt + 60_000,
      }),
    ).resolves.toMatchObject({ checked: 1, ready: true, visible: 1, visibleJobs: 1 });
    expect(database.value("SELECT completed_at FROM analytics_deletion_jobs")).toBe(secondCheckAt);
    database.close();
  });
});

function erasureRequest(
  overrides: Partial<{
    startedAt: number;
    deleteReason: "retention_expired" | "delete_requested";
    requiresWarehouseTombstone: number;
  }> = {},
) {
  return {
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    startedAt: overrides.startedAt ?? 500,
    deleteReason: overrides.deleteReason ?? ("retention_expired" as const),
    requiresWarehouseTombstone: overrides.requiresWarehouseTombstone ?? 1,
  };
}

type SqlValue = string | number | bigint | Uint8Array | null;

interface TestD1Result {
  meta: { changes: number };
}

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

  run(query: string, ...values: SqlValue[]): void {
    this.sqlite.prepare(query).run(...values);
  }

  row(query: string, ...values: SqlValue[]): Record<string, unknown> | undefined {
    return this.sqlite.prepare(query).get(...values);
  }

  value(query: string, ...values: SqlValue[]): unknown {
    return Object.values(this.row(query, ...values) ?? {})[0];
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

async function createLifecycleDatabase(): Promise<TestD1Database> {
  const database = new TestD1Database();
  database.sqlite.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, jurisdiction TEXT);
    CREATE TABLE sessions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE session_deletions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (project_id, session_id)
    );`);
  const migrations = await Promise.all(
    [
      "0009_analytics_warehouse.sql",
      "0016_analytics_deletion_started_at.sql",
      "0018_analytics_deletion_v2.sql",
    ].map(async (fileName) =>
      readFile(new URL(`../migrations/${fileName}`, import.meta.url), "utf8"),
    ),
  );
  for (const migration of migrations) database.sqlite.exec(migration);
  return database;
}

function lifecycleDatabase(
  database: TestD1Database,
): Parameters<typeof recordAnalyticsErasureRequests>[0] {
  return database as unknown as Parameters<typeof recordAnalyticsErasureRequests>[0];
}
