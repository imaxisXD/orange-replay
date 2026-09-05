import { describe, expect, it, vi } from "vite-plus/test";
import { type FinalizeMessage } from "@orange-replay/shared";
import { createTestDatabaseSchema } from "../src/test/database-schema.ts";
import { reserveAcceptedUsage } from "../src/usage/accepted-usage.ts";
import { SessionRecorderStore } from "../src/do/session-recorder-store.ts";
import {
  confirmIndexedFinalizationStatement,
  finalizationReceiptHash,
  markFinalizationReady,
  readFinalizationJob,
  registerSessionFinalization,
  repairSessionFinalizations,
  type FinalizationRegistration,
} from "../src/consumer/finalization-recovery.ts";
import type { Env } from "../src/env.ts";
import { PurgeTestDatabase, type PurgeTestStatement } from "./analytics-purge-test-database.ts";

class RecoveryDatabase extends PurgeTestDatabase {
  override async batch(statements: readonly PurgeTestStatement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        const rows = await statement.all();
        results.push({
          results: rows.results,
          meta: { changes: Number(this.value("SELECT changes()")) },
        });
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

async function database() {
  const local = new RecoveryDatabase();
  const db = local as unknown as Parameters<typeof registerSessionFinalization>[0];
  await createTestDatabaseSchema(db);
  return { local, db };
}

function registration(sessionId = "session-recovery"): FinalizationRegistration {
  return {
    projectId: "project-recovery",
    sessionId,
    orgId: "org-recovery",
    objectId: `object-${sessionId}`,
    shard: 0,
    retentionDays: 30,
    startedAt: 1_000,
    now: 2_000,
  };
}

function message(): FinalizeMessage {
  return {
    type: "session.finalized",
    projectId: "project-recovery",
    sessionId: "session-recovery",
    orgId: "org-recovery",
    shard: 0,
    requestId: "request-recovery",
    manifestKey: "p/project-recovery/session-recovery/manifest.json",
    analyticsSidecarKey: "p/project-recovery/session-recovery/analytics.ndjson",
    startedAt: 1_000,
    endedAt: 2_000,
    bytes: 100,
    segments: 1,
    flags: 0,
    counts: { batches: 1, events: 0, clicks: 0, errors: 0, rages: 0, navs: 0 },
    attrs: {},
    retentionDays: 30,
    events: [],
  };
}

describe("durable session finalization recovery", () => {
  it("keeps a versioned receipt through tombstone replacement and storage recreation", async () => {
    const { local } = await database();
    try {
      const sql = {
        exec(query: string, ...values: (string | number | null)[]) {
          if (query.includes("CREATE TABLE")) {
            local.sqlite.exec(query);
            return;
          }
          const rows = local.sqlite.prepare(query).all(...values);
          return { toArray: () => rows, one: () => rows[0] };
        },
      } as unknown as ConstructorParameters<typeof SessionRecorderStore>[0];
      const store = new SessionRecorderStore(sql);
      store.createSchema();
      store.markFinalizationRegistered();
      store.saveFinalizationReceipt(message());
      store.replaceStateWithTombstone({
        finalized: true,
        finalizedAt: 3_000,
        purgeAt: 4_000,
        firstRequestId: "request-recovery",
      });
      const recovered = new SessionRecorderStore(sql);
      recovered.createSchema();
      expect(recovered.readFinalizationReceipt()).toEqual(message());
      expect(recovered.finalizationIsComplete()).toBe(false);
      expect(
        local.value("SELECT json_extract(receipt, '$.receiptFormat') FROM finalization_recovery"),
      ).toBe(1);
      recovered.completeFinalizationReceipt();
      expect(recovered.readFinalizationReceipt()).toBeNull();
      expect(recovered.finalizationIsComplete()).toBe(true);
    } finally {
      local.close();
    }
  });
  it("registers before acceptance without changing the billing changes() chain", async () => {
    const { local, db } = await database();
    try {
      const input = registration();
      const reservation = {
        projectId: input.projectId,
        sessionId: input.sessionId,
        orgId: input.orgId,
        month: "2026-01",
        bytes: 100,
        updatedAt: input.now,
        source: "append" as const,
        finalizationRegistration: input,
      };
      await reserveAcceptedUsage(db, reservation);
      await reserveAcceptedUsage(db, reservation);
      await reserveAcceptedUsage(db, { ...reservation, bytes: 150 });
      expect(local.row("SELECT sessions, bytes FROM usage_monthly")).toEqual({
        sessions: 0,
        bytes: 150,
      });
      expect(local.value("SELECT COUNT(*) FROM session_finalization_jobs")).toBe(1);
      expect(await readFinalizationJob(db, input)).toMatchObject({
        state: "recording",
        object_id: input.objectId,
      });
    } finally {
      local.close();
    }
  });

  it("does not acknowledge a deletion-fenced registration and retains discoverable cleanup", async () => {
    const { local, db } = await database();
    try {
      local.run(
        "INSERT INTO session_deletions (project_id, session_id, requested_at) VALUES (?, ?, ?)",
        "project-recovery",
        "session-recovery",
        1,
      );
      await expect(registerSessionFinalization(db, registration())).rejects.toThrow(
        "recovery record could not be saved",
      );
      expect(await readFinalizationJob(db, registration())).toMatchObject({
        delete_analytics: 1,
        state: "recording",
      });
      await expect(markFinalizationReady(db, message(), registration().objectId)).rejects.toThrow(
        "could not be confirmed",
      );
      expect(local.value("SELECT receipt_hash FROM session_finalization_jobs")).toBeNull();
    } finally {
      local.close();
    }
  });

  it("freezes a receipt and commits its index acknowledgement atomically", async () => {
    const { local, db } = await database();
    try {
      await registerSessionFinalization(db, registration());
      await markFinalizationReady(db, message(), registration().objectId);
      const hash = await finalizationReceiptHash(message());
      await expect(
        markFinalizationReady(db, { ...message(), bytes: 101 }, registration().objectId),
      ).rejects.toThrow("could not be confirmed");
      const ack = confirmIndexedFinalizationStatement(db, message(), hash);
      local.run("CREATE TABLE rollback_proof (value INTEGER CHECK(value = 1))");
      await expect(
        db.batch([ack, db.prepare("INSERT INTO rollback_proof VALUES (2)")]),
      ).rejects.toThrow();
      expect(local.value("SELECT state FROM session_finalization_jobs")).toBe("ready");
      await db.batch([ack]);
      expect(local.value("SELECT state FROM session_finalization_jobs")).toBe("indexed");
      await markFinalizationReady(db, message(), registration().objectId);
      expect(local.value("SELECT state FROM session_finalization_jobs")).toBe("indexed");
    } finally {
      local.close();
    }
  });

  it("repairs beyond Queue retry exhaustion and isolates one failed recording", async () => {
    const { local, db } = await database();
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    try {
      await registerSessionFinalization(db, registration("a-failed"));
      await registerSessionFinalization(db, registration("b-healthy"));
      local.run("UPDATE session_finalization_jobs SET next_attempt_at = 0, attempts = 20");
      const repair = vi.fn(async ({ sessionId }: { sessionId: string }) => {
        if (sessionId === "a-failed") throw new Error("Storage unavailable.");
        return { complete: false, nextAttemptAt: 9_000_000 };
      });
      const env = {
        IDX_00: db,
        SESSION: { idFromString: (id: string) => id, get: () => ({ repairFinalization: repair }) },
      } as unknown as Env;
      await repairSessionFinalizations(env, 5_000_000);
      expect(repair).toHaveBeenCalledTimes(2);
      expect(
        local.row(
          "SELECT attempts, lease_owner FROM session_finalization_jobs WHERE session_id = 'a-failed'",
        ),
      ).toEqual({ attempts: 21, lease_owner: null });
      expect(
        local.value(
          "SELECT next_attempt_at FROM session_finalization_jobs WHERE session_id = 'b-healthy'",
        ),
      ).toBe(9_000_000);
    } finally {
      local.close();
      log.mockRestore();
    }
  });

  it("expires replay without requesting immediate analytics erasure", async () => {
    const { local, db } = await database();
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    try {
      await registerSessionFinalization(db, registration());
      await markFinalizationReady(db, message(), registration().objectId);
      local.run("UPDATE session_finalization_jobs SET next_attempt_at = 0");
      const repair = vi.fn(async () => ({ complete: false, nextAttemptAt: 3_000_000_000 }));
      await repairSessionFinalizations(
        {
          IDX_00: db,
          SESSION: {
            idFromString: (id: string) => id,
            get: () => ({ repairFinalization: repair }),
          },
        } as unknown as Env,
        3_000_000_000,
      );
      expect(local.value("SELECT delete_analytics FROM session_deletions")).toBe(0);
      expect(local.value("SELECT requested_at FROM analytics_deletion_jobs")).toBeGreaterThan(
        3_000_000_000,
      );
      expect(local.value("SELECT COUNT(*) FROM session_finalization_jobs")).toBe(1);
    } finally {
      local.close();
      log.mockRestore();
    }
  });
});
