import { readFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { queueDeletionExportsFromJournal } from "../src/analytics/deletion-journal.ts";
import { drainAnalyticsExports } from "../src/analytics/exporter.ts";
import { createD1AnalyticsOutboxStore } from "../src/analytics/outbox.ts";
import { markRowsForDeletion, selectExpiredSessions } from "../src/consumer/sweeper.ts";

describe("analytics deletion journal", () => {
  it("repairs a saved default-residency tombstone after the project is removed", async () => {
    const database = new TestD1Database();
    database.sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, jurisdiction TEXT)");
    database.sqlite.exec(
      await readFile(
        new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url),
        "utf8",
      ),
    );
    database.sqlite
      .prepare("INSERT INTO projects (id, jurisdiction) VALUES (?, ?), (?, ?), (?, ?)")
      .run("default-project", null, "eu-project", "eu", "empty-project", "");
    const insertJob = database.sqlite.prepare(
      `INSERT INTO analytics_deletion_jobs (
        project_id, session_id, requested_at, delete_reason, requires_warehouse_tombstone
      ) VALUES (?, ?, 100, 'delete_requested', ?)`,
    );
    insertJob.run("default-project", "session-default", 1);
    insertJob.run("eu-project", "session-eu", 0);
    insertJob.run("empty-project", "session-empty", 0);
    database.sqlite.prepare("DELETE FROM projects WHERE id = ?").run("default-project");
    const db = database as unknown as Parameters<typeof queueDeletionExportsFromJournal>[0];

    await expect(queueDeletionExportsFromJournal(db, 200)).resolves.toBe(1);
    await expect(queueDeletionExportsFromJournal(db, 300)).resolves.toBe(0);
    expect(
      database.sqlite
        .prepare("SELECT project_id FROM analytics_export_outbox ORDER BY project_id")
        .all(),
    ).toEqual([{ project_id: "default-project" }]);
    expect(
      database.sqlite
        .prepare(
          `SELECT deletion_export_sequence FROM analytics_deletion_jobs
          WHERE project_id = 'default-project'`,
        )
        .get(),
    ).toEqual({ deletion_export_sequence: 1 });

    const send = vi.fn(async () => {});
    await expect(
      drainAnalyticsExports(createD1AnalyticsOutboxStore(db), { send }, { now: 400 }),
    ).resolves.toMatchObject({ selected: 1, sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledWith([
      expect.objectContaining({
        record_kind: "deletion",
        project_id: "default-project",
        session_id: "session-default",
      }),
    ]);
    database.sqlite.close();
  });

  it("defaults a legacy job with missing project context to requiring a tombstone", async () => {
    const database = new TestD1Database();
    database.sqlite.exec(
      await readFile(
        new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url),
        "utf8",
      ),
    );
    database.sqlite.exec(
      `INSERT INTO analytics_deletion_jobs (
        project_id, session_id, requested_at, delete_reason
      ) VALUES ('removed-project', 'legacy-session', 100, 'delete_requested')`,
    );
    expect(
      database.sqlite
        .prepare("SELECT requires_warehouse_tombstone AS required FROM analytics_deletion_jobs")
        .get(),
    ).toEqual({ required: 1 });

    const db = database as unknown as Parameters<typeof queueDeletionExportsFromJournal>[0];
    await expect(queueDeletionExportsFromJournal(db, 200)).resolves.toBe(1);
    expect(database.sqlite.prepare("SELECT project_id FROM analytics_export_outbox").get()).toEqual(
      {
        project_id: "removed-project",
      },
    );
    database.sqlite.close();
  });

  it("uses only exact-session export evidence after a residency change", async () => {
    const database = await sweeperDatabase();
    database.sqlite
      .prepare("INSERT INTO projects (id, jurisdiction) VALUES (?, NULL), (?, NULL)")
      .run("old-project", "default-project");
    const insertSession = database.sqlite.prepare(
      "INSERT INTO sessions (project_id, session_id, expires_at) VALUES (?, ?, 10)",
    );
    insertSession.run("old-project", "outbox-session");
    insertSession.run("old-project", "ledger-session");
    insertSession.run("old-project", "never-exported");
    insertSession.run("default-project", "default-session");
    insertSession.run("removed-project", "removed-session");
    database.sqlite
      .prepare(
        `INSERT INTO analytics_export_outbox (
          export_id, project_id, session_id, record_kind, payload_json, created_at
        ) VALUES ('session:old-project:outbox-session', 'old-project', 'outbox-session',
          'session', '{}', 1)`,
      )
      .run();
    database.sqlite
      .prepare(
        `INSERT INTO analytics_export_ledger (
          export_id, export_sequence, project_id, session_id, record_kind,
          sent_at, first_seen_verified_at
        ) VALUES ('session:old-project:ledger-session', 20, 'old-project', 'ledger-session',
          'session', 2, 3)`,
      )
      .run();
    database.sqlite
      .prepare(
        `INSERT INTO analytics_warehouse_state (project_id, verified_sequence)
        VALUES ('old-project', 20)`,
      )
      .run();
    database.sqlite
      .prepare("UPDATE projects SET jurisdiction = 'eu' WHERE id = 'old-project'")
      .run();

    const db = database as unknown as Parameters<typeof selectExpiredSessions>[0];
    const rows = await selectExpiredSessions(db, 100);
    const requiredBySession = Object.fromEntries(
      rows.map((row) => [row.sessionId, row.requiresWarehouseTombstone]),
    );

    expect(requiredBySession).toEqual({
      "default-session": 1,
      "ledger-session": 1,
      "never-exported": 0,
      "outbox-session": 1,
      "removed-session": 1,
    });
    database.sqlite.close();
  });

  it("upgrades a saved deletion job to require warehouse cleanup and never downgrades it", async () => {
    const database = await sweeperDatabase();
    database.sqlite.exec(
      `INSERT INTO analytics_deletion_jobs (
        project_id, session_id, requested_at, delete_reason, requires_warehouse_tombstone
      ) VALUES ('project', 'session', 100, 'delete_requested', 0)`,
    );
    const db = database as unknown as Parameters<typeof markRowsForDeletion>[0];
    const requiredRow = {
      projectId: "project",
      sessionId: "session",
      deleteReason: "delete_requested" as const,
      requiresWarehouseTombstone: 1,
    };

    await markRowsForDeletion(db, [requiredRow], 200);
    await markRowsForDeletion(db, [{ ...requiredRow, requiresWarehouseTombstone: 0 }], 300);

    expect(
      database.sqlite
        .prepare(
          `SELECT requires_warehouse_tombstone AS required
          FROM analytics_deletion_jobs WHERE project_id = 'project' AND session_id = 'session'`,
        )
        .get(),
    ).toEqual({ required: 1 });
    database.sqlite.close();
  });
});

async function sweeperDatabase(): Promise<TestD1Database> {
  const database = new TestD1Database();
  database.sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, jurisdiction TEXT)");
  database.sqlite.exec(
    `CREATE TABLE sessions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE session_deletions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (project_id, session_id)
    );`,
  );
  database.sqlite.exec(
    await readFile(new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url), "utf8"),
  );
  return database;
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

  async batch(statements: TestD1Statement[]): Promise<TestD1Result[]> {
    const results: TestD1Result[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const statement of statements) results.push(await statement.runWithResult());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
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
    return this.runWithResult();
  }

  async runWithResult(): Promise<TestD1Result> {
    const result = this.statement.run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}
