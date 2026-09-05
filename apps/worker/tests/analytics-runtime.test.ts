import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { readWarehouseSnapshot } from "../src/analytics/runtime.ts";

describe("analytics warehouse runtime gate", () => {
  it("reads the real SQL gates in one database request and keeps deletion state above an old pin", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(
        readFileSync(
          new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url),
          "utf8",
        ),
      );
      sqlite.exec(`
        INSERT INTO analytics_warehouse_state (project_id, verified_sequence)
        VALUES ('project_1', 12);
        INSERT INTO analytics_backfill_completions
          (project_id, source_session_count, source_cutoff_ms, required_sequence, report_id, completed_at)
        VALUES ('project_1', 2, 1, 4, 'report_1', 1);
        INSERT INTO analytics_deletion_jobs
          (project_id, session_id, requested_at, delete_reason, deletion_export_sequence)
        VALUES ('project_1', 'verified', 1, 'privacy', 11),
               ('other_project', 'pending', 1, 'privacy', NULL);
      `);
      sqlite
        .prepare(`INSERT INTO analytics_deletion_jobs
        (project_id, session_id, requested_at, delete_reason)
        VALUES ('project_1', 'future', ?, 'retention')`)
        .run(Date.now() + 60_000);
      const first = vi.fn(
        async (sql: string, bindings: SQLInputValue[]) =>
          sqlite.prepare(sql).get(...bindings) ?? null,
      );
      const batch = vi.fn(async (statements: { sql: string; bindings: SQLInputValue[] }[]) => {
        sqlite.exec("BEGIN");
        try {
          return statements.map(({ sql, bindings }) => ({
            results: sqlite.prepare(sql).all(...bindings),
          }));
        } finally {
          sqlite.exec("ROLLBACK");
        }
      });
      const db = {
        batch,
        prepare(sql: string) {
          return {
            bind(...bindings: SQLInputValue[]) {
              return { sql, bindings, first: () => first(sql, bindings) };
            },
          };
        },
      } as unknown as Parameters<typeof readWarehouseSnapshot>[0];

      await expect(readWarehouseSnapshot(db, "project_1", 8)).resolves.toEqual({
        deletionTableVersion: "v1",
        ok: true,
        privacyVersion: 11,
        version: 8,
        analyticsDelivery: {
          state: "current",
          pendingExports: 0,
          oldestPendingAt: null,
          checkedAt: expect.any(Number),
        },
      });
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0]?.[0]).toHaveLength(5);
      expect(first).not.toHaveBeenCalled();

      sqlite.exec(
        `UPDATE analytics_deletion_jobs SET requested_at = 1 WHERE session_id = 'future'`,
      );
      await expect(readWarehouseSnapshot(db, "project_1", 8)).resolves.toEqual({
        error: "analytics_deletion_pending",
        ok: false,
        status: 503,
      });
      sqlite.exec(`INSERT INTO analytics_export_outbox
        (export_id, project_id, session_id, record_kind, payload_json, created_at, quarantined_at)
        VALUES ('failed_export', 'project_1', 'session', 'session', '{}', 1, 1)`);
      await expect(readWarehouseSnapshot(db, "project_1", 99, "v2")).resolves.toEqual({
        error: "analytics_export_quarantined",
        ok: false,
        status: 503,
      });
      expect(batch).toHaveBeenCalledTimes(3);
      expect(first).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it("counts sent and unsent exports beyond the current watermark, without aging an idle project", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(
        readFileSync(
          new URL("../migrations/0009_analytics_warehouse.sql", import.meta.url),
          "utf8",
        ),
      );
      sqlite.exec(`
        INSERT INTO analytics_warehouse_state (project_id, verified_sequence, verified_at)
        VALUES ('project_1', 12, 1);
        INSERT INTO analytics_backfill_completions
          (project_id, source_session_count, source_cutoff_ms, required_sequence, report_id, completed_at)
        VALUES ('project_1', 1, 1, 4, 'report_1', 1), ('empty', 0, 1, 0, 'empty_report', 1);
        INSERT INTO analytics_export_outbox
          (export_sequence, export_id, project_id, session_id, record_kind, payload_json, created_at, sent_at)
        VALUES (8, 'verified', 'project_1', 's1', 'session', '{}', 1, 2),
               (13, 'sent', 'project_1', 's2', 'session', '{}', 100, 101),
               (15, 'other', 'project_2', 's3', 'session', '{}', 5, NULL),
               (20, 'unsent', 'project_1', 's4', 'event', '{}', 200, NULL);
      `);
      const queries: string[] = [];
      const db = {
        prepare(sql: string) {
          queries.push(sql);
          return { bind: (...bindings: SQLInputValue[]) => ({ sql, bindings }) };
        },
        async batch(statements: { sql: string; bindings: SQLInputValue[] }[]) {
          return statements.map(({ sql, bindings }) => ({
            results: sqlite.prepare(sql).all(...bindings),
          }));
        },
      } as unknown as Parameters<typeof readWarehouseSnapshot>[0];

      expect(await readWarehouseSnapshot(db, "project_1", 8)).toMatchObject({
        version: 8,
        analyticsDelivery: { state: "pending", pendingExports: 2, oldestPendingAt: 100 },
      });
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all("project_1");
      expect(
        plan.some((row) =>
          String(row["detail"]).includes("idx_analytics_export_outbox_project_sequence"),
        ),
      ).toBe(true);

      sqlite.exec("UPDATE analytics_warehouse_state SET verified_sequence = 20");
      expect(await readWarehouseSnapshot(db, "project_1", 8)).toMatchObject({
        version: 8,
        analyticsDelivery: { state: "current", pendingExports: 0, oldestPendingAt: null },
      });
      expect(await readWarehouseSnapshot(db, "empty")).toMatchObject({
        version: 0,
        analyticsDelivery: { state: "current", pendingExports: 0, oldestPendingAt: null },
      });
    } finally {
      sqlite.close();
    }
  });

  it("refuses warehouse reads when some rows are verified but backfill is not complete", async () => {
    const db = makeDatabase({
      backfillCompleted: false,
      requiredSequence: 0,
      verifiedSequence: 42,
    });

    await expect(readWarehouseSnapshot(db, "project_1")).resolves.toEqual({
      error: "analytics_backfill_pending",
      ok: false,
      status: 503,
    });
  });

  it("allows an explicitly completed empty backfill at warehouse version zero", async () => {
    const db = makeDatabase({ backfillCompleted: true, requiredSequence: 0, verifiedSequence: 0 });

    await expect(readWarehouseSnapshot(db, "project_1")).resolves.toEqual({
      deletionTableVersion: "v1",
      ok: true,
      privacyVersion: 0,
      version: 0,
    });
  });

  it("checks the completion receipt before validating a requested version", async () => {
    const pending = makeDatabase({
      backfillCompleted: false,
      requiredSequence: 0,
      verifiedSequence: 4,
    });
    const complete = makeDatabase({
      backfillCompleted: true,
      requiredSequence: 4,
      verifiedSequence: 4,
    });

    await expect(readWarehouseSnapshot(pending, "project_1", 5)).resolves.toMatchObject({
      error: "analytics_backfill_pending",
      status: 503,
    });
    await expect(readWarehouseSnapshot(complete, "project_1", 5)).resolves.toMatchObject({
      error: "invalid_warehouse_version",
      status: 400,
    });
  });

  it("waits until R2 has verified every sequence required by the completed source scan", async () => {
    const partial = makeDatabase({
      backfillCompleted: true,
      requiredSequence: 10,
      verifiedSequence: 9,
    });
    const complete = makeDatabase({
      backfillCompleted: true,
      requiredSequence: 10,
      verifiedSequence: 12,
    });

    await expect(readWarehouseSnapshot(partial, "project_1")).resolves.toMatchObject({
      error: "analytics_backfill_pending",
      status: 503,
    });
    await expect(readWarehouseSnapshot(complete, "project_1", 9)).resolves.toMatchObject({
      error: "invalid_warehouse_version",
      status: 400,
    });
    await expect(readWarehouseSnapshot(complete, "project_1", 10)).resolves.toEqual({
      deletionTableVersion: "v1",
      ok: true,
      privacyVersion: 0,
      version: 10,
    });
  });

  it("changes the privacy epoch only after a deletion is verified", async () => {
    const ordinaryExport = makeDatabase({
      backfillCompleted: true,
      requiredSequence: 4,
      verifiedSequence: 12,
    });
    const verifiedDeletion = makeDatabase({
      backfillCompleted: true,
      privacyVersion: 11,
      requiredSequence: 4,
      verifiedSequence: 12,
    });

    await expect(readWarehouseSnapshot(ordinaryExport, "project_1")).resolves.toMatchObject({
      privacyVersion: 0,
      version: 12,
    });
    await expect(readWarehouseSnapshot(verifiedDeletion, "project_1")).resolves.toMatchObject({
      privacyVersion: 11,
      version: 12,
    });
  });

  it("rejects an incomplete marker without its source count and report identity", async () => {
    const db = makeDatabase({
      backfillCompleted: true,
      backfillMarkerValid: false,
      requiredSequence: 0,
      verifiedSequence: 0,
    });

    await expect(readWarehouseSnapshot(db, "project_1")).resolves.toMatchObject({
      error: "analytics_backfill_pending",
      status: 503,
    });
  });

  it("fails closed when any project export is quarantined", async () => {
    const db = makeDatabase({
      backfillCompleted: true,
      quarantinedExport: true,
      requiredSequence: 8,
      verifiedSequence: 20,
    });

    await expect(readWarehouseSnapshot(db, "project_1", 8)).resolves.toMatchObject({
      error: "analytics_export_quarantined",
      status: 503,
    });
  });

  it("keeps a pending deletion closed even after backfill completion", async () => {
    const db = makeDatabase({
      backfillCompleted: true,
      pendingDeletion: true,
      requiredSequence: 8,
      verifiedSequence: 8,
    });

    await expect(readWarehouseSnapshot(db, "project_1")).resolves.toMatchObject({
      error: "analytics_deletion_pending",
      status: 503,
    });
  });

  it("uses v1 until every retained v2 deletion is visible", async () => {
    const waiting = makeDatabase({
      backfillCompleted: true,
      deletionV2Ready: false,
      requiredSequence: 0,
      verifiedSequence: 0,
    });
    const ready = makeDatabase({
      backfillCompleted: true,
      deletionV2Ready: true,
      requiredSequence: 0,
      verifiedSequence: 0,
    });
    const migrationPending = makeDatabase({
      backfillCompleted: true,
      deletionV2QueryFails: true,
      requiredSequence: 0,
      verifiedSequence: 0,
    });

    await expect(
      readWarehouseSnapshot(waiting, "project_1", undefined, "v2"),
    ).resolves.toMatchObject({ deletionTableVersion: "v1", ok: true });
    await expect(readWarehouseSnapshot(ready, "project_1", undefined, "v2")).resolves.toMatchObject(
      { deletionTableVersion: "v2", ok: true },
    );
    await expect(
      readWarehouseSnapshot(migrationPending, "project_1", undefined, "v2"),
    ).resolves.toMatchObject({ deletionTableVersion: "v1", ok: true });
  });
});

function makeDatabase(options: {
  backfillCompleted: boolean;
  backfillMarkerValid?: boolean;
  deletionV2QueryFails?: boolean;
  deletionV2Ready?: boolean;
  pendingDeletion?: boolean;
  privacyVersion?: number;
  quarantinedExport?: boolean;
  requiredSequence: number;
  verifiedSequence: number;
}): Parameters<typeof readWarehouseSnapshot>[0] {
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => {
        if (sql.includes("analytics_deletion_v2_state")) {
          if (options.deletionV2QueryFails === true) {
            throw new Error("no such table: analytics_deletion_v2_state");
          }
          return { ready: options.deletionV2Ready === true ? 1 : 0 };
        }
        if (sql.includes("analytics_backfill_completions")) {
          return options.backfillCompleted
            ? {
                completed_at: 1,
                report_id: options.backfillMarkerValid === false ? "" : "report_1",
                required_sequence: options.requiredSequence,
                source_session_count: options.backfillMarkerValid === false ? -1 : 2,
              }
            : null;
        }
        if (sql.includes("quarantined_at IS NOT NULL")) {
          return options.quarantinedExport === true ? { present: 1 } : null;
        }
        if (sql.includes("MAX(j.deletion_export_sequence)")) {
          return { privacy_version: options.privacyVersion ?? 0 };
        }
        if (sql.includes("analytics_deletion_jobs")) {
          return options.pendingDeletion === true ? { present: 1 } : null;
        }
        if (sql.includes("analytics_warehouse_state")) {
          return { verified_sequence: options.verifiedSequence };
        }
        throw new Error("The runtime test received an unknown D1 query.");
      }),
    })),
  }));

  const batch = vi.fn(async (statements: { first(): Promise<unknown> }[]) =>
    Promise.all(
      statements.map(async (statement) => {
        const row = await statement.first();
        return { results: row === null ? [] : [row] };
      }),
    ),
  );
  return { prepare, batch } as unknown as Parameters<typeof readWarehouseSnapshot>[0];
}
