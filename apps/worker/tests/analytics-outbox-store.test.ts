import { readFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createD1AnalyticsOutboxStore } from "../src/analytics/outbox.ts";

describe("analytics outbox project selection", () => {
  it("checks never-tried and oldest-tried projects before recently-tried projects", async () => {
    const database = new TestD1Database();
    const migration = await readFile(
      new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url),
      "utf8",
    );
    database.sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, jurisdiction TEXT)");
    database.sqlite.exec(migration);

    seedExport(database, 1, "old-a");
    seedExport(database, 2, "recent");
    seedExport(database, 5, "done");
    seedExport(database, 10, "old-b");
    seedExport(database, 20, "never");
    seedExport(database, 30, "old-a");
    database.sqlite
      .prepare(
        `INSERT INTO analytics_warehouse_state (
          project_id, verified_sequence, last_attempt_at
        ) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
      )
      .run("old-a", 1, 100, "old-b", 0, 100, "recent", 0, 200, "done", 99, 50);

    const store = createD1AnalyticsOutboxStore(
      database as unknown as Parameters<typeof createD1AnalyticsOutboxStore>[0],
    );

    await expect(store.listProjectIds(90)).resolves.toEqual(["never", "old-b", "old-a", "recent"]);
    await expect(store.listProjectIds(2)).resolves.toEqual(["never", "old-b"]);
    await store.saveWarehouseState({
      projectId: "never",
      verifiedSequence: 0,
      verifiedAt: null,
      lastAttemptAt: 300,
      lastError: null,
    });
    await store.saveWarehouseState({
      projectId: "old-b",
      verifiedSequence: 0,
      verifiedAt: null,
      lastAttemptAt: 300,
      lastError: null,
    });
    await expect(store.listProjectIds(2)).resolves.toEqual(["old-a", "recent"]);
    database.sqlite.close();
  });

  it("removes quarantined rows from delivery without deleting their evidence", async () => {
    const database = new TestD1Database();
    const migration = await readFile(
      new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url),
      "utf8",
    );
    database.sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, jurisdiction TEXT)");
    database.sqlite.exec(migration);
    seedExport(database, 1, "project");
    seedExport(database, 2, "project");
    const store = createD1AnalyticsOutboxStore(
      database as unknown as Parameters<typeof createD1AnalyticsOutboxStore>[0],
    );

    await store.markQuarantined([1], "invalid session fields", 500);
    await store.saveSidecarProgress(2, 4);
    await store.saveSidecarProgress(2, 2);

    await expect(store.listPending(90)).resolves.toMatchObject([
      {
        exportSequence: 2,
        quarantinedAt: null,
        quarantineReason: null,
        sidecarEventOffset: 4,
      },
    ]);
    expect(
      database.sqlite
        .prepare(
          `SELECT quarantined_at, quarantine_reason, attempt_count
          FROM analytics_export_outbox WHERE export_sequence = 1`,
        )
        .get(),
    ).toEqual({
      quarantined_at: 500,
      quarantine_reason: "invalid session fields",
      attempt_count: 1,
    });
    database.sqlite.close();
  });

  it("stops pending analytics delivery after a project changes residency", async () => {
    const database = new TestD1Database();
    database.sqlite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, jurisdiction TEXT)");
    database.sqlite.exec(
      await readFile(
        new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url),
        "utf8",
      ),
    );
    seedExport(database, 1, "project");
    const store = createD1AnalyticsOutboxStore(
      database as unknown as Parameters<typeof createD1AnalyticsOutboxStore>[0],
    );

    await expect(store.listPending(90)).resolves.toHaveLength(1);
    await expect(store.canSendRecord("project", "session-1", "session")).resolves.toBe(true);

    database.sqlite.prepare("UPDATE projects SET jurisdiction = 'eu' WHERE id = 'project'").run();

    await expect(store.listPending(90)).resolves.toHaveLength(1);
    await expect(store.canSendRecord("project", "session-1", "session")).resolves.toBe(false);
    database.sqlite.close();
  });
});

type SqlValue = string | number | bigint | Uint8Array | null;

class TestD1Database {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(query: string): TestD1Statement {
    return new TestD1Statement(this.sqlite.prepare(query));
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

  async run(): Promise<void> {
    this.statement.run(...this.values);
  }
}

function seedExport(database: TestD1Database, exportSequence: number, projectId: string): void {
  database.sqlite
    .prepare("INSERT OR IGNORE INTO projects (id, jurisdiction) VALUES (?, NULL)")
    .run(projectId);
  database.sqlite
    .prepare(
      `INSERT INTO analytics_export_outbox (
        export_sequence, export_id, project_id, session_id, record_kind, payload_json, created_at
      ) VALUES (?, ?, ?, ?, 'session', '{}', 1)`,
    )
    .run(
      exportSequence,
      `session:${projectId}:session-${String(exportSequence)}`,
      projectId,
      `session-${String(exportSequence)}`,
    );
}
