import { readFile } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { buildSessionWhere } from "../src/api/helpers.ts";
import {
  ANALYTICS_OUTBOX_SAFETY_MS,
  compactVerifiedAnalyticsOutbox,
} from "../src/analytics/outbox.ts";

describe("analytics outbox compaction", () => {
  it("keeps each verified payload for 24 hours before deleting it", async () => {
    const database = await createDatabase();
    const now = Date.UTC(2026, 6, 13, 12, 0, 0);
    seedExport(database, {
      exportSequence: 1,
      exportId: "session:project:ready",
      sessionId: "ready",
      sentAt: now - 1_000,
    });
    seedExport(database, {
      exportSequence: 2,
      exportId: "session:project:pending",
      sessionId: "pending",
      sentAt: null,
    });
    seedExport(database, {
      exportSequence: 3,
      exportId: "event:project:ready",
      sessionId: "ready",
      recordKind: "event",
      sentAt: now - 1_000,
    });
    seedExport(database, {
      exportSequence: 4,
      exportId: "session:project:not-verified",
      sessionId: "not-verified",
      sentAt: now - ANALYTICS_OUTBOX_SAFETY_MS,
    });
    database.run(
      "INSERT INTO analytics_warehouse_state (project_id, verified_sequence, verified_at) VALUES (?, ?, ?)",
      "project",
      3,
      now - 500,
    );

    const first = await compact(database, { now });
    expect(first).toEqual({
      copiedToLedger: 2,
      deletedPayloadRows: 0,
      deletedDeniedLedgerRows: 0,
    });
    expect(
      database.values("SELECT export_id FROM analytics_export_ledger ORDER BY export_id"),
    ).toEqual(["event:project:ready", "session:project:ready"]);
    expect(database.value("SELECT COUNT(*) FROM analytics_export_outbox")).toBe(4);

    const justBefore = await compact(database, {
      now: now + ANALYTICS_OUTBOX_SAFETY_MS - 1,
    });
    expect(justBefore.deletedPayloadRows).toBe(0);

    const afterSafetyWindow = await compact(database, {
      now: now + ANALYTICS_OUTBOX_SAFETY_MS,
    });
    expect(afterSafetyWindow.deletedPayloadRows).toBe(2);
    expect(
      database.values("SELECT export_id FROM analytics_export_outbox ORDER BY export_sequence"),
    ).toEqual(["session:project:pending", "session:project:not-verified"]);
    database.close();
  });

  it("copies work in bounded batches without getting stuck on existing ledger rows", async () => {
    const database = await createDatabase();
    const now = Date.UTC(2026, 6, 13, 12, 0, 0);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      seedExport(database, {
        exportSequence: sequence,
        exportId: `session:project:session-${String(sequence)}`,
        sessionId: `session-${String(sequence)}`,
        sentAt: now - 1_000,
      });
    }
    database.run(
      "INSERT INTO analytics_warehouse_state (project_id, verified_sequence, verified_at) VALUES (?, ?, ?)",
      "project",
      5,
      now - 500,
    );

    expect((await compact(database, { limit: 2, now })).copiedToLedger).toBe(2);
    expect((await compact(database, { limit: 2, now: now + 1 })).copiedToLedger).toBe(2);
    expect((await compact(database, { limit: 2, now: now + 2 })).copiedToLedger).toBe(1);
    expect(database.value("SELECT COUNT(*) FROM analytics_export_ledger")).toBe(5);
    expect(database.value("SELECT COUNT(*) FROM analytics_export_outbox")).toBe(5);
    database.close();
  });

  it("removes ledger identities while a durable session deletion denies reads", async () => {
    const database = await createDatabase();
    database.run(
      `INSERT INTO analytics_export_ledger (
        export_id, export_sequence, project_id, session_id, record_kind, sent_at,
        first_seen_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
      "session:project:delete-me",
      1,
      "project",
      "delete-me",
      "session",
      1,
      2,
      "session:project:keep-me",
      2,
      "project",
      "keep-me",
      "session",
      1,
      2,
    );
    database.run(
      "INSERT INTO session_deletions (project_id, session_id, requested_at) VALUES (?, ?, ?)",
      "project",
      "delete-me",
      3,
    );

    const result = await compact(database, { now: 4 });

    expect(result.deletedDeniedLedgerRows).toBe(1);
    expect(database.values("SELECT export_id FROM analytics_export_ledger")).toEqual([
      "session:project:keep-me",
    ]);
    database.close();
  });

  it("keeps versioned D1 comparisons working across outbox and ledger rows", async () => {
    const database = await createDatabase();
    database.run(
      "CREATE TABLE sessions (project_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (project_id, session_id))",
    );
    for (const sessionId of ["from-ledger", "from-outbox", "future", "missing", "denied"]) {
      database.run(
        "INSERT INTO sessions (project_id, session_id) VALUES (?, ?)",
        "project",
        sessionId,
      );
    }
    database.run(
      `INSERT INTO analytics_export_ledger (
        export_id, export_sequence, project_id, session_id, record_kind, sent_at,
        first_seen_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
      "session:project:from-ledger",
      1,
      "project",
      "from-ledger",
      "session",
      1,
      2,
      "session:project:future",
      3,
      "project",
      "future",
      "session",
      1,
      2,
      "session:project:denied",
      2,
      "project",
      "denied",
      "session",
      1,
      2,
    );
    seedExport(database, {
      exportSequence: 2,
      exportId: "session:project:from-outbox",
      sessionId: "from-outbox",
      sentAt: 1,
    });
    database.run(
      "INSERT INTO session_deletions (project_id, session_id, requested_at) VALUES (?, ?, ?)",
      "project",
      "denied",
      3,
    );

    const where = buildSessionWhere("project", { warehouse_version: 2 });
    const sessionIds = database.values(
      `SELECT session_id FROM sessions WHERE ${where.sql} ORDER BY session_id`,
      ...where.bindings,
    );

    expect(sessionIds).toEqual(["from-ledger", "from-outbox"]);
    database.close();
  });
});

type SqlValue = string | number | bigint | Uint8Array | null;

class TestDatabase {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(query: string): TestStatement {
    return new TestStatement(this.sqlite.prepare(query));
  }

  async batch(statements: readonly TestStatement[]): Promise<readonly TestResult[]> {
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

  value(query: string, ...values: SqlValue[]): unknown {
    return Object.values(this.sqlite.prepare(query).get(...values) ?? {})[0];
  }

  values(query: string, ...values: SqlValue[]): unknown[] {
    return this.sqlite
      .prepare(query)
      .all(...values)
      .map((row) => Object.values(row)[0]);
  }

  close(): void {
    this.sqlite.close();
  }
}

class TestStatement {
  private values: SqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: SqlValue[]): TestStatement {
    this.values = values;
    return this;
  }

  runNow(): TestResult {
    const result = this.statement.run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

interface TestResult {
  meta: { changes: number };
}

async function createDatabase(): Promise<TestDatabase> {
  const database = new TestDatabase();
  const migration = await readFile(
    new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url),
    "utf8",
  );
  database.sqlite.exec(migration);
  database.run(
    `CREATE TABLE session_deletions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    )`,
  );
  return database;
}

async function compact(database: TestDatabase, options: { limit?: number; now?: number }) {
  return compactVerifiedAnalyticsOutbox(
    database as unknown as Parameters<typeof compactVerifiedAnalyticsOutbox>[0],
    options,
  );
}

function seedExport(
  database: TestDatabase,
  input: {
    exportSequence: number;
    exportId: string;
    sessionId: string;
    recordKind?: "session" | "event" | "deletion";
    sentAt: number | null;
  },
): void {
  database.run(
    `INSERT INTO analytics_export_outbox (
      export_sequence, export_id, project_id, session_id, record_kind, payload_json,
      created_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.exportSequence,
    input.exportId,
    "project",
    input.sessionId,
    input.recordKind ?? "session",
    "{}",
    1,
    input.sentAt,
  );
}
