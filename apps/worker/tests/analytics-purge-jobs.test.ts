import { describe, expect, it } from "vite-plus/test";
import {
  ANALYTICS_PURGE_ALERT_MS,
  ANALYTICS_PURGE_LEASE_MS,
  ANALYTICS_PURGE_QUIET_MS,
  claimAnalyticsPurgeJobs,
  markPurgeDeadlineAlerted,
  reportAnalyticsPurgeResults,
} from "../src/analytics/erasure-lifecycle.ts";
import {
  createPurgeTestDatabase,
  type PurgeTestDatabase,
} from "./analytics-purge-test-database.ts";

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

describe("analytics physical deletion jobs", () => {
  it("claims only quiet, unleased jobs whose warehouse tombstone is ready", async () => {
    const database = await createPurgeTestDatabase();
    for (const [projectId, jurisdiction] of [
      ["default-ready", null],
      ["default-wait", null],
      ["restricted", "eu"],
      ["too-new", null],
      ["leased", null],
    ] as const) {
      database.run(
        "INSERT INTO projects (id, jurisdiction) VALUES (?, ?)",
        projectId,
        jurisdiction,
      );
    }
    seedWarehouseState(database, "default-ready", 10);
    seedWarehouseState(database, "default-wait", 9);
    seedWarehouseState(database, "missing-project", 999);
    seedWarehouseState(database, "too-new", 10);
    seedWarehouseState(database, "leased", 10);

    seedJob(database, {
      projectId: "default-ready",
      sessionId: "session-ready",
      requestedAt: NOW - ANALYTICS_PURGE_ALERT_MS - 1,
      deletionExportSequence: 10,
    });
    seedJob(database, {
      projectId: "restricted",
      sessionId: "session-restricted",
      requestedAt: NOW - ANALYTICS_PURGE_QUIET_MS - 5_000,
      deletionExportSequence: 999,
      requiresWarehouseTombstone: false,
    });
    seedJob(database, {
      projectId: "missing-project",
      sessionId: "session-missing",
      requestedAt: NOW - ANALYTICS_PURGE_QUIET_MS - 4_000,
      deletionExportSequence: 999,
      requiresWarehouseTombstone: true,
    });
    seedJob(database, {
      projectId: "default-wait",
      sessionId: "session-wait",
      requestedAt: NOW - ANALYTICS_PURGE_QUIET_MS - 3_000,
      deletionExportSequence: 10,
    });
    seedJob(database, {
      projectId: "too-new",
      sessionId: "session-new",
      requestedAt: NOW - ANALYTICS_PURGE_QUIET_MS + 1,
      deletionExportSequence: 10,
    });
    seedJob(database, {
      projectId: "leased",
      sessionId: "session-leased",
      requestedAt: NOW - ANALYTICS_PURGE_QUIET_MS - 2_000,
      deletionExportSequence: 10,
      leaseOwner: "other-runner",
      leaseExpiresAt: NOW + ANALYTICS_PURGE_LEASE_MS,
    });

    const db = database as unknown as Parameters<typeof claimAnalyticsPurgeJobs>[0];
    const claimed = await claimAnalyticsPurgeJobs(db, "runner-1", NOW, 20);

    expect(claimed).toEqual({
      jobs: [
        {
          projectId: "default-ready",
          sessionId: "session-ready",
          requestedAt: NOW - ANALYTICS_PURGE_ALERT_MS - 1,
          deleteReason: "delete_requested",
          requiresWarehouseTombstone: true,
          needsPhysicalMaintenance: true,
        },
        {
          projectId: "restricted",
          sessionId: "session-restricted",
          requestedAt: NOW - ANALYTICS_PURGE_QUIET_MS - 5_000,
          deleteReason: "delete_requested",
          requiresWarehouseTombstone: false,
          needsPhysicalMaintenance: true,
        },
        {
          projectId: "missing-project",
          sessionId: "session-missing",
          requestedAt: NOW - ANALYTICS_PURGE_QUIET_MS - 4_000,
          deleteReason: "delete_requested",
          requiresWarehouseTombstone: true,
          needsPhysicalMaintenance: true,
        },
      ],
      deadlineRisk: true,
      oldestPendingAt: NOW - ANALYTICS_PURGE_ALERT_MS - 1,
    });
    expect(
      database.row(
        `SELECT lease_owner, lease_expires_at, purge_attempts
        FROM analytics_deletion_jobs WHERE project_id = ?`,
        "default-ready",
      ),
    ).toEqual({
      lease_owner: "runner-1",
      lease_expires_at: NOW + ANALYTICS_PURGE_LEASE_MS,
      purge_attempts: 1,
    });

    const secondClaim = await claimAnalyticsPurgeJobs(db, "runner-2", NOW, 20);
    expect(secondClaim.jobs).toEqual([]);
    database.close();
  });

  it("completes only after two zero checks separated by the quiet window", async () => {
    const database = await createPurgeTestDatabase();
    database.run("INSERT INTO projects (id, jurisdiction) VALUES ('project', NULL)");
    seedWarehouseState(database, "project", 1);
    seedJob(database, {
      projectId: "project",
      sessionId: "session",
      requestedAt: NOW - ANALYTICS_PURGE_QUIET_MS,
      deletionExportSequence: 1,
    });
    const db = database as unknown as Parameters<typeof claimAnalyticsPurgeJobs>[0];

    await claimAnalyticsPurgeJobs(db, "runner-first", NOW, 1);
    await expect(
      reportAnalyticsPurgeResults(
        db,
        "runner-first",
        [
          {
            projectId: "project",
            sessionId: "session",
            rowsRemaining: 0,
            rowsFoundBefore: 1,
          },
        ],
        NOW,
      ),
    ).resolves.toEqual({ completed: 0, waitingForSecondCheck: 1, failed: 0 });
    expect(
      database.row("SELECT first_zero_at, completed_at, lease_owner FROM analytics_deletion_jobs"),
    ).toEqual({ first_zero_at: NOW, completed_at: null, lease_owner: null });

    seedJob(database, {
      projectId: "missing-project",
      sessionId: "other-session",
      requestedAt: NOW - 100,
      requiresWarehouseTombstone: false,
    });
    const claimBeforeSecondCheck = await claimAnalyticsPurgeJobs(
      db,
      "runner-other",
      NOW + ANALYTICS_PURGE_QUIET_MS - 1,
      1,
    );
    expect(claimBeforeSecondCheck.jobs.map((job) => job.sessionId)).toEqual(["other-session"]);

    const secondCheckClaim = await claimAnalyticsPurgeJobs(
      db,
      "runner-second",
      NOW + ANALYTICS_PURGE_QUIET_MS,
      1,
    );
    expect(secondCheckClaim.jobs[0]?.needsPhysicalMaintenance).toBe(false);
    await expect(
      reportAnalyticsPurgeResults(
        db,
        "runner-second",
        [
          {
            projectId: "project",
            sessionId: "session",
            rowsRemaining: 0,
            rowsFoundBefore: 1,
          },
        ],
        NOW + ANALYTICS_PURGE_QUIET_MS,
      ),
    ).resolves.toEqual({ completed: 0, waitingForSecondCheck: 1, failed: 0 });
    expect(database.value("SELECT first_zero_at FROM analytics_deletion_jobs")).toBe(
      NOW + ANALYTICS_PURGE_QUIET_MS,
    );

    await claimAnalyticsPurgeJobs(db, "runner-third", NOW + 2 * ANALYTICS_PURGE_QUIET_MS, 1);
    await expect(
      reportAnalyticsPurgeResults(
        db,
        "runner-third",
        [
          {
            projectId: "project",
            sessionId: "session",
            rowsRemaining: 0,
            rowsFoundBefore: 0,
          },
        ],
        NOW + 2 * ANALYTICS_PURGE_QUIET_MS,
      ),
    ).resolves.toEqual({ completed: 1, waitingForSecondCheck: 0, failed: 0 });
    expect(database.value("SELECT completed_at FROM analytics_deletion_jobs")).toBe(
      NOW + 2 * ANALYTICS_PURGE_QUIET_MS,
    );
    database.close();
  });

  it("records failures, rejects reports from another owner, and rate-limits deadline alerts", async () => {
    const database = await createPurgeTestDatabase();
    seedJob(database, {
      projectId: "missing-project",
      sessionId: "session",
      requestedAt: NOW - ANALYTICS_PURGE_ALERT_MS - 1,
      requiresWarehouseTombstone: false,
    });
    const db = database as unknown as Parameters<typeof claimAnalyticsPurgeJobs>[0];
    await claimAnalyticsPurgeJobs(db, "owner", NOW, 1);

    await expect(
      reportAnalyticsPurgeResults(
        db,
        "wrong-owner",
        [
          {
            projectId: "missing-project",
            sessionId: "session",
            rowsRemaining: 1,
            rowsFoundBefore: 1,
          },
        ],
        NOW,
      ),
    ).rejects.toThrow("did not own every claimed job");

    await expect(
      reportAnalyticsPurgeResults(
        db,
        "owner",
        [
          {
            projectId: "missing-project",
            sessionId: "session",
            rowsRemaining: 1,
            rowsFoundBefore: 1,
            error: "Spark delete failed",
          },
        ],
        NOW,
      ),
    ).resolves.toEqual({ completed: 0, waitingForSecondCheck: 0, failed: 1 });
    expect(database.value("SELECT purge_last_error FROM analytics_deletion_jobs")).toBe(
      "Spark delete failed",
    );

    await expect(markPurgeDeadlineAlerted(db, NOW)).resolves.toBe(1);
    await expect(markPurgeDeadlineAlerted(db, NOW + 1_000)).resolves.toBe(0);
    await expect(markPurgeDeadlineAlerted(db, NOW + 60 * 60 * 1_000 + 1)).resolves.toBe(1);
    database.close();
  });
});

function seedWarehouseState(
  database: PurgeTestDatabase,
  projectId: string,
  verifiedSequence: number,
): void {
  database.run(
    `INSERT INTO analytics_warehouse_state (project_id, verified_sequence)
    VALUES (?, ?)`,
    projectId,
    verifiedSequence,
  );
}

function seedJob(
  database: PurgeTestDatabase,
  input: {
    projectId: string;
    sessionId: string;
    requestedAt: number;
    deletionExportSequence?: number;
    leaseOwner?: string;
    leaseExpiresAt?: number;
    requiresWarehouseTombstone?: boolean;
  },
): void {
  database.run(
    `INSERT INTO analytics_deletion_jobs (
      project_id, session_id, requested_at, delete_reason, deletion_export_sequence,
      lease_owner, lease_expires_at, requires_warehouse_tombstone
    ) VALUES (?, ?, ?, 'delete_requested', ?, ?, ?, ?)`,
    input.projectId,
    input.sessionId,
    input.requestedAt,
    input.deletionExportSequence ?? null,
    input.leaseOwner ?? null,
    input.leaseExpiresAt ?? null,
    input.requiresWarehouseTombstone === false ? 0 : 1,
  );
}
