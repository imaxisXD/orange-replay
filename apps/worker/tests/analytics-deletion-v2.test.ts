import { readFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildAnalyticsDeletionV2Record,
  buildAnalyticsDeletionV2VisibilityQuery,
  createAnalyticsDeletionV2Visibility,
  deletionV2ExportId,
  maintainAnalyticsDeletionV2,
  type AnalyticsDeletionV2Record,
} from "../src/analytics/deletion-v2.ts";

describe("analytics deletion v2 backfill", () => {
  it("sends and proves every required retained job, including completed jobs", async () => {
    const database = await createDatabase();
    const accepted: AnalyticsDeletionV2Record[] = [];
    const visibleIds = new Set<string>();
    const proveTableExists = vi.fn(async () => undefined);
    const pipeline = {
      async send(records: readonly Record<string, unknown>[]) {
        accepted.push(...(records as AnalyticsDeletionV2Record[]));
      },
    };
    const visibility = {
      async findVisibleExportIds(input: { records: readonly AnalyticsDeletionV2Record[] }) {
        return new Set(
          input.records.map((record) => record.export_id).filter((id) => visibleIds.has(id)),
        );
      },
      proveTableExists,
    };

    const sent = await maintainAnalyticsDeletionV2(
      deletionDatabase(database),
      pipeline,
      visibility,
      { now: 1_000 },
    );

    expect(sent).toMatchObject({
      ready: false,
      requiredJobs: 3,
      selected: 3,
      sent: 3,
      visibleJobs: 0,
    });
    expect(accepted).toEqual([
      expect.objectContaining({
        export_id: deletionV2ExportId("project", "live-session"),
        session_started_at: 40,
      }),
      expect.objectContaining({
        export_id: deletionV2ExportId("project", "outbox-session"),
        session_started_at: 60,
      }),
      expect.objectContaining({
        export_id: deletionV2ExportId("project", "completed-session"),
        session_started_at: null,
      }),
    ]);
    expect(accepted.every((record) => record.schema_version === 2)).toBe(true);
    expect(accepted.some((record) => record.session_id === "no-warehouse-session")).toBe(false);
    expect(proveTableExists).not.toHaveBeenCalled();

    for (const record of accepted) visibleIds.add(record.export_id);
    const visible = await maintainAnalyticsDeletionV2(
      deletionDatabase(database),
      pipeline,
      visibility,
      { now: 61_000 },
    );

    expect(visible).toMatchObject({
      checked: 3,
      missing: 0,
      ready: true,
      requiredJobs: 3,
      selected: 0,
      visible: 3,
      visibleJobs: 3,
    });
    expect(proveTableExists).toHaveBeenCalledOnce();
    expect(
      database.row(
        `SELECT required_job_count, visible_job_count, last_error, backfill_completed_at
        FROM analytics_deletion_v2_state WHERE shard = 0`,
      ),
    ).toEqual({
      backfill_completed_at: 61_000,
      last_error: null,
      required_job_count: 3,
      visible_job_count: 3,
    });
    database.close();
  });

  it("keeps a missing row durable and resends its stable id", async () => {
    const database = await createDatabase();
    const sentIds: string[] = [];
    const pipeline = {
      async send(records: readonly Record<string, unknown>[]) {
        sentIds.push(...records.map((record) => String(record["export_id"])));
      },
    };
    const visibility = {
      async findVisibleExportIds() {
        return new Set<string>();
      },
      async proveTableExists() {},
    };

    await maintainAnalyticsDeletionV2(deletionDatabase(database), pipeline, visibility, {
      now: 1_000,
    });
    const waiting = await maintainAnalyticsDeletionV2(
      deletionDatabase(database),
      pipeline,
      visibility,
      { now: 61_000 },
    );
    const resent = await maintainAnalyticsDeletionV2(
      deletionDatabase(database),
      pipeline,
      visibility,
      { now: 62_000 },
    );

    expect(waiting).toMatchObject({ checked: 3, missing: 3, ready: false });
    expect(resent).toMatchObject({ selected: 3, sent: 3 });
    expect(sentIds).toHaveLength(6);
    expect(sentIds.slice(0, 3)).toEqual(sentIds.slice(3));
    expect(
      database.row(
        `SELECT deletion_v2_attempt_count, deletion_v2_sent_at, deletion_v2_last_error
        FROM analytics_deletion_jobs
        WHERE project_id = 'project' AND session_id = 'completed-session'`,
      ),
    ).toEqual({
      deletion_v2_attempt_count: 2,
      deletion_v2_last_error: null,
      deletion_v2_sent_at: 62_000,
    });
    database.close();
  });

  it("records a delivery failure without losing the job", async () => {
    const database = await createDatabase();

    await expect(
      maintainAnalyticsDeletionV2(
        deletionDatabase(database),
        {
          async send() {
            throw new Error("v2 stream is unavailable");
          },
        },
        {
          async findVisibleExportIds() {
            return new Set<string>();
          },
          async proveTableExists() {},
        },
        { now: 1_000 },
      ),
    ).rejects.toThrow("Analytics deletion v2 delivery failed");

    expect(
      database.row(
        `SELECT deletion_v2_attempt_count, deletion_v2_sent_at, deletion_v2_last_error
        FROM analytics_deletion_jobs
        WHERE project_id = 'project' AND session_id = 'live-session'`,
      ),
    ).toEqual({
      deletion_v2_attempt_count: 1,
      deletion_v2_last_error: "v2 stream is unavailable",
      deletion_v2_sent_at: null,
    });
    database.close();
  });

  it("does not let one invalid old job starve later valid jobs", async () => {
    const database = await createDatabase();
    database.sqlite.exec(
      `UPDATE analytics_deletion_jobs
      SET session_started_at = requested_at + 1
      WHERE project_id = 'project' AND session_id = 'live-session'`,
    );
    const sentIds: string[] = [];
    const pipeline = {
      async send(records: readonly Record<string, unknown>[]) {
        sentIds.push(...records.map((record) => String(record["export_id"])));
      },
    };
    const visibility = {
      async findVisibleExportIds() {
        return new Set<string>();
      },
      async proveTableExists() {},
    };

    await expect(
      maintainAnalyticsDeletionV2(deletionDatabase(database), pipeline, visibility, {
        batchSize: 1,
        now: 1_000,
      }),
    ).resolves.toMatchObject({ failed: 1, selected: 1, sent: 0 });
    await expect(
      maintainAnalyticsDeletionV2(deletionDatabase(database), pipeline, visibility, {
        batchSize: 1,
        now: 2_000,
      }),
    ).resolves.toMatchObject({ failed: 0, selected: 1, sent: 1 });

    expect(sentIds).toEqual([deletionV2ExportId("project", "outbox-session")]);
    database.close();
  });

  it("does not approve an empty backfill until the v2 table can be queried", async () => {
    const database = await createDatabase();
    database.sqlite.exec("DELETE FROM analytics_deletion_jobs");

    await expect(
      maintainAnalyticsDeletionV2(
        deletionDatabase(database),
        { async send() {} },
        {
          async findVisibleExportIds() {
            return new Set<string>();
          },
          async proveTableExists() {
            throw new Error("analytics_deletions_v2 does not exist");
          },
        },
        { now: 1_000 },
      ),
    ).rejects.toThrow("Analytics deletion v2 table check failed");

    expect(
      database.row(
        `SELECT required_job_count, visible_job_count, last_error, backfill_completed_at
        FROM analytics_deletion_v2_state WHERE shard = 0`,
      ),
    ).toEqual({
      backfill_completed_at: null,
      last_error: "analytics_deletions_v2 does not exist",
      required_job_count: 0,
      visible_job_count: 0,
    });
    database.close();
  });
});

describe("analytics deletion v2 visibility", () => {
  it("queries only the versioned table and accepts only exact field matches", async () => {
    const exact = buildAnalyticsDeletionV2Record({
      projectId: "project",
      sessionId: "session",
      requestedAt: 100,
      deleteReason: "delete_requested",
      sessionStartedAt: 50,
      exportSequence: 1,
    });
    const query = buildAnalyticsDeletionV2VisibilityQuery({
      projectId: "project",
      records: [exact],
    });
    expect(query).toContain('FROM "default"."analytics_deletions_v2" d');
    expect(query).not.toContain('"analytics_deletions"');

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        success: true,
        result: {
          rows: [
            {
              schema_version: exact.schema_version,
              record_kind: exact.record_kind,
              project_id: "project",
              export_id: exact.export_id,
              export_sequence: exact.export_sequence,
              session_id: exact.session_id,
              deleted_at: exact.deleted_at,
              delete_reason: exact.delete_reason,
              session_started_at: 49,
            },
          ],
          schema: [],
          metrics: { bytes_scanned: 1, files_scanned: 1 },
        },
      }),
    );
    const adapter = createAnalyticsDeletionV2Visibility({
      accountId: "account",
      bucketName: "bucket",
      token: "token",
    });

    await expect(
      adapter.findVisibleExportIds({ projectId: "project", records: [exact] }),
    ).resolves.toEqual(new Set());
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
  database.sqlite.exec(`CREATE TABLE sessions (
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, session_id)
  )`);
  const migrations = await Promise.all(
    ["0009_analytics_warehouse.sql", "0016_analytics_deletion_started_at.sql"].map(
      async (fileName) => readFile(new URL(`../migrations/${fileName}`, import.meta.url), "utf8"),
    ),
  );
  for (const migration of migrations) database.sqlite.exec(migration);

  database.sqlite.exec(`
    INSERT INTO sessions (project_id, session_id, started_at)
    VALUES ('project', 'live-session', 40);

    INSERT INTO analytics_export_outbox (
      export_id, project_id, session_id, record_kind, payload_json, created_at
    ) VALUES (
      'session:project:outbox-session', 'project', 'outbox-session', 'session',
      '{"started_at":60}', 1
    );

    INSERT INTO analytics_deletion_jobs (
      project_id, session_id, requested_at, delete_reason,
      requires_warehouse_tombstone, deletion_export_sequence, completed_at
    ) VALUES
      ('project', 'live-session', 100, 'delete_requested', 1, 1, NULL),
      ('project', 'outbox-session', 110, 'delete_requested', 1, 2, NULL),
      ('project', 'completed-session', 120, 'retention_expired', 1, 3, 130),
      ('project', 'no-warehouse-session', 130, 'delete_requested', 0, NULL, 140);
  `);
  database.sqlite.exec(
    await readFile(
      new URL("../migrations/0018_analytics_deletion_v2.sql", import.meta.url),
      "utf8",
    ),
  );
  return database;
}

function deletionDatabase(
  database: TestD1Database,
): Parameters<typeof maintainAnalyticsDeletionV2>[0] {
  return database as unknown as Parameters<typeof maintainAnalyticsDeletionV2>[0];
}
