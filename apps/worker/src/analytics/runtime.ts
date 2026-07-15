import type { Env } from "../env.ts";
import type { AnalyticsDeletionReadVersion } from "../env.ts";
import type { R2SqlSettings } from "./r2-sql-client.ts";
import type { AnalyticsDeletionTableVersion } from "./warehouse-query.ts";

interface WarehouseStateRow {
  verified_sequence: number;
}

interface BackfillCompletionRow {
  completed_at: number;
  required_sequence: number;
  report_id: string;
  source_session_count: number;
}

interface PrivacyVersionRow {
  privacy_version: number;
}

export type WarehouseSnapshotResult =
  | {
      ok: true;
      version: number;
      privacyVersion: number;
      deletionTableVersion: AnalyticsDeletionTableVersion;
    }
  | {
      ok: false;
      error:
        | "analytics_backfill_pending"
        | "analytics_deletion_pending"
        | "analytics_export_quarantined"
        | "invalid_warehouse_version";
      status: 400 | 503;
    };

export function r2SqlSettingsFromEnv(
  env: Pick<Env, "R2_SQL_ACCOUNT_ID" | "R2_SQL_BUCKET" | "R2_SQL_TOKEN">,
): R2SqlSettings {
  return {
    accountId: env.R2_SQL_ACCOUNT_ID ?? "",
    bucketName: env.R2_SQL_BUCKET ?? "",
    token: env.R2_SQL_TOKEN ?? "",
  };
}

export async function readWarehouseSnapshot(
  db: D1Database,
  projectId: string,
  requestedVersion?: number,
  requestedDeletionVersion: AnalyticsDeletionReadVersion = "v1",
): Promise<WarehouseSnapshotResult> {
  const [state, backfillCompletion, pendingDeletion, privacyState, quarantinedExport] =
    await Promise.all([
      db
        .prepare(
          `SELECT verified_sequence
        FROM analytics_warehouse_state
        WHERE project_id = ?`,
        )
        .bind(projectId)
        .first<WarehouseStateRow>(),
      db
        .prepare(
          `SELECT completed_at, required_sequence, source_session_count, report_id
        FROM analytics_backfill_completions
        WHERE project_id = ?`,
        )
        .bind(projectId)
        .first<BackfillCompletionRow>(),
      db
        .prepare(
          `SELECT 1 AS present
        FROM analytics_deletion_jobs j
        LEFT JOIN analytics_warehouse_state s ON s.project_id = j.project_id
        WHERE j.project_id = ?
          AND (
            j.deletion_export_sequence IS NULL
            OR j.deletion_export_sequence > COALESCE(s.verified_sequence, 0)
          )
        LIMIT 1`,
        )
        .bind(projectId)
        .first<{ present: number }>(),
      db
        .prepare(
          `SELECT COALESCE(MAX(j.deletion_export_sequence), 0) AS privacy_version
        FROM analytics_deletion_jobs j
        LEFT JOIN analytics_warehouse_state s ON s.project_id = j.project_id
        WHERE j.project_id = ?
          AND j.deletion_export_sequence <= COALESCE(s.verified_sequence, 0)`,
        )
        .bind(projectId)
        .first<PrivacyVersionRow>(),
      db
        .prepare(
          `SELECT 1 AS present
        FROM analytics_export_outbox
        WHERE project_id = ? AND quarantined_at IS NOT NULL
        LIMIT 1`,
        )
        .bind(projectId)
        .first<{ present: number }>(),
    ]);
  const verified = state?.verified_sequence ?? 0;
  const privacyVersion = privacyState?.privacy_version ?? 0;

  if (quarantinedExport !== null) {
    return { ok: false, error: "analytics_export_quarantined", status: 503 };
  }
  if (pendingDeletion !== null) {
    return { ok: false, error: "analytics_deletion_pending", status: 503 };
  }
  if (backfillCompletion === null || !isValidBackfillCompletion(backfillCompletion)) {
    return { ok: false, error: "analytics_backfill_pending", status: 503 };
  }
  if (verified < backfillCompletion.required_sequence) {
    return { ok: false, error: "analytics_backfill_pending", status: 503 };
  }
  if (requestedVersion !== undefined && requestedVersion > verified) {
    return { ok: false, error: "invalid_warehouse_version", status: 400 };
  }
  if (requestedVersion !== undefined && requestedVersion < backfillCompletion.required_sequence) {
    return { ok: false, error: "invalid_warehouse_version", status: 400 };
  }
  const deletionTableVersion =
    requestedDeletionVersion === "v2" && (await deletionV2IsReady(db)) ? "v2" : "v1";
  return {
    ok: true,
    version: requestedVersion ?? verified,
    // Ordinary exports can advance the data snapshot without invalidating a
    // useful last-good result. A verified deletion advances this separate
    // privacy epoch, including for an explicitly requested old data version.
    privacyVersion,
    deletionTableVersion,
  };
}

async function deletionV2IsReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT CASE WHEN
        s.backfill_completed_at IS NOT NULL
        AND s.last_error IS NULL
        AND s.required_job_count = s.visible_job_count
        AND NOT EXISTS (
          SELECT 1
          FROM analytics_deletion_jobs
          WHERE requires_warehouse_tombstone = 1
            AND deletion_v2_visible_at IS NULL
        )
      THEN 1 ELSE 0 END AS ready
      FROM analytics_deletion_v2_state s
      WHERE s.shard = 0`,
      )
      .bind()
      .first<{ ready: number }>();
    return row?.ready === 1;
  } catch {
    // A deployment that has not applied the v2 D1 migration is not ready.
    // The existing v1 table remains a complete, safe fallback.
    return false;
  }
}

function isValidBackfillCompletion(row: BackfillCompletionRow): boolean {
  return (
    Number.isSafeInteger(row.completed_at) &&
    row.completed_at > 0 &&
    Number.isSafeInteger(row.required_sequence) &&
    row.required_sequence >= 0 &&
    Number.isSafeInteger(row.source_session_count) &&
    row.source_session_count >= 0 &&
    typeof row.report_id === "string" &&
    row.report_id.length > 0
  );
}
