import { describe, expect, it, vi } from "vite-plus/test";
import { readWarehouseSnapshot } from "../src/analytics/runtime.ts";

describe("analytics warehouse runtime gate", () => {
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

  return { prepare } as unknown as Parameters<typeof readWarehouseSnapshot>[0];
}
