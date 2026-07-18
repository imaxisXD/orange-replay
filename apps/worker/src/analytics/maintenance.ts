import { startWideEvent, uuidv7, type WideEventOutcome } from "@orange-replay/shared";
import {
  analyticsDeletionReadVersion,
  analyticsExportEnabled,
  analyticsReadBackend,
  setWorkerLoggerVersion,
  shardDb,
  type Env,
} from "../env.ts";
import { drainAnalyticsExports, reconcileAnalyticsExports } from "./exporter.ts";
import { queueDeletionExportsFromJournal } from "./erasure-lifecycle.ts";
import {
  type AnalyticsDeletionV2Record,
  createAnalyticsDeletionV2Visibility,
  maintainAnalyticsDeletionV2,
} from "./deletion-v2.ts";
import {
  releaseAnalyticsLease,
  renewAnalyticsLease,
  reserveAnalyticsSendWindow,
  tryAcquireAnalyticsLease,
} from "./lease.ts";
import { compactVerifiedAnalyticsOutbox, createD1AnalyticsOutboxStore } from "./outbox.ts";
import {
  ANALYTICS_PIPELINE_BYTES_PER_SECOND,
  createRateLimitedAnalyticsPipeline,
} from "./rate-limited-pipeline.ts";
import { r2SqlSettingsFromEnv } from "./runtime.ts";
import { createR2SqlVisibilityAdapter } from "./warehouse-visibility.ts";

const OUTBOX_BATCH_SIZE = 90;
const MAX_DRAIN_PASSES = 10;
const MAX_COMPACTION_PASSES = 10;

/**
 * Sends durable D1 outbox rows to Pipelines, then advances only the R2 SQL
 * version that can be proved visible. Queue completion calls this for low
 * latency; the five-minute cron is the repair path after an outage or restart.
 */
export async function maintainAnalyticsWarehouse(env: Env): Promise<void> {
  setWorkerLoggerVersion(env);
  const wideEvent = startWideEvent("worker", "consumer.analytics_warehouse", uuidv7());
  let outcome: WideEventOutcome = "success";
  let leaseDb: D1Database | null = null;
  let leaseOwner: string | null = null;

  try {
    const stream = env.ANALYTICS_STREAM;
    const exportEnabled = analyticsExportEnabled(env);
    if (!exportEnabled) {
      wideEvent.set({ analytics_configured: false });
      if (analyticsReadBackend(env) !== "d1") {
        throw new Error("Analytics exports are disabled while warehouse reads are enabled.");
      }
      return;
    }
    if (stream === undefined) {
      throw new Error("Analytics export is enabled, but its stream is not configured.");
    }

    const db = shardDb(env, 0);
    const ownerId = uuidv7();
    if (!(await tryAcquireAnalyticsLease(db, ownerId))) {
      wideEvent.set({
        analytics_configured: true,
        analytics_lease_acquired: false,
        analytics_skipped: "lease_busy",
      });
      return;
    }
    leaseDb = db;
    leaseOwner = ownerId;
    wideEvent.set({ analytics_lease_acquired: true });

    const renewLease = async (): Promise<void> => {
      if (!(await renewAnalyticsLease(db, ownerId))) {
        throw new Error("Analytics export lease expired before maintenance completed.");
      }
    };
    const repairedDeletionExports = await queueDeletionExportsFromJournal(db);
    const store = createD1AnalyticsOutboxStore(db);
    const beforeSend = async (requestBytes: number): Promise<number> => {
      const waitMs = await reserveAnalyticsSendWindow(
        db,
        ownerId,
        requestBytes,
        ANALYTICS_PIPELINE_BYTES_PER_SECOND,
      );
      if (waitMs === 0) await renewLease();
      return waitMs;
    };
    const pipeline = createRateLimitedAnalyticsPipeline(stream, { beforeSend });
    let selected = 0;
    let sent = 0;
    let failed = 0;
    let drainPasses = 0;

    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
      await renewLease();
      drainPasses += 1;
      const result = await drainAnalyticsExports(store, pipeline, {
        limit: OUTBOX_BATCH_SIZE,
        sidecarReader: env.RECORDINGS,
      });
      selected += result.selected;
      sent += result.sent;
      failed += result.failed;
      if (result.selected < OUTBOX_BATCH_SIZE) break;
    }

    await renewLease();
    const reconciled = await reconcileAnalyticsExports(
      store,
      createR2SqlVisibilityAdapter(r2SqlSettingsFromEnv(env)),
      { recordsPerProject: OUTBOX_BATCH_SIZE },
    );

    let deletionV2: Awaited<ReturnType<typeof maintainAnalyticsDeletionV2>> | undefined;
    if (env.ANALYTICS_DELETION_V2_STREAM !== undefined) {
      await renewLease();
      deletionV2 = await maintainAnalyticsDeletionV2(
        db,
        createRateLimitedAnalyticsPipeline<AnalyticsDeletionV2Record>(
          env.ANALYTICS_DELETION_V2_STREAM,
          { beforeSend },
        ),
        createAnalyticsDeletionV2Visibility(r2SqlSettingsFromEnv(env)),
        { batchSize: OUTBOX_BATCH_SIZE },
      );
    } else if (analyticsDeletionReadVersion(env) === "v2") {
      throw new Error(
        "Analytics deletion v2 reads were requested, but the v2 stream is not configured.",
      );
    }

    let compactionPasses = 0;
    let copiedToLedger = 0;
    let deletedPayloadRows = 0;
    let deletedDeniedLedgerRows = 0;
    for (let pass = 0; pass < MAX_COMPACTION_PASSES; pass += 1) {
      await renewLease();
      compactionPasses += 1;
      const compacted = await compactVerifiedAnalyticsOutbox(db, {
        limit: OUTBOX_BATCH_SIZE,
      });
      copiedToLedger += compacted.copiedToLedger;
      deletedPayloadRows += compacted.deletedPayloadRows;
      deletedDeniedLedgerRows += compacted.deletedDeniedLedgerRows;
      if (
        compacted.copiedToLedger < OUTBOX_BATCH_SIZE &&
        compacted.deletedPayloadRows < OUTBOX_BATCH_SIZE &&
        compacted.deletedDeniedLedgerRows < OUTBOX_BATCH_SIZE
      ) {
        break;
      }
    }

    wideEvent.set({
      analytics_configured: true,
      deletion_exports_repaired: repairedDeletionExports,
      exports_selected: selected,
      exports_sent: sent,
      exports_failed: failed,
      drain_passes: drainPasses,
      projects_checked: reconciled.projectsChecked,
      projects_failed: reconciled.projectsFailed,
      records_checked: reconciled.recordsChecked,
      records_missing: reconciled.recordsMissing,
      projects_advanced: reconciled.projectsAdvanced,
      deletion_v2_configured: deletionV2 !== undefined,
      deletion_v2_selected: deletionV2?.selected ?? 0,
      deletion_v2_sent: deletionV2?.sent ?? 0,
      deletion_v2_failed: deletionV2?.failed ?? 0,
      deletion_v2_checked: deletionV2?.checked ?? 0,
      deletion_v2_visible: deletionV2?.visible ?? 0,
      deletion_v2_missing: deletionV2?.missing ?? 0,
      deletion_v2_required_jobs: deletionV2?.requiredJobs ?? 0,
      deletion_v2_visible_jobs: deletionV2?.visibleJobs ?? 0,
      deletion_v2_ready: deletionV2?.ready ?? false,
      compaction_passes: compactionPasses,
      ledger_rows_copied: copiedToLedger,
      outbox_payload_rows_deleted: deletedPayloadRows,
      denied_ledger_rows_deleted: deletedDeniedLedgerRows,
    });
    if (failed > 0 || reconciled.projectsFailed > 0) outcome = "server_error";
  } catch (error) {
    outcome = "server_error";
    wideEvent.fail(error);
    throw error;
  } finally {
    if (leaseDb !== null && leaseOwner !== null) {
      try {
        await releaseAnalyticsLease(leaseDb, leaseOwner);
      } catch (error) {
        outcome = "server_error";
        wideEvent.set({ analytics_lease_release_error: safeLeaseError(error) });
      }
    }
    wideEvent.emit(outcome);
  }
}

function safeLeaseError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown lease release error";
  return message.slice(0, 500);
}
