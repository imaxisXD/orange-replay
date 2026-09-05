import {
  finalizeMessageSchema,
  startWideEvent,
  uuidv7,
  type FinalizeMessage,
} from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
import { recordAnalyticsErasureRequests } from "../analytics/erasure-lifecycle.ts";

export const FINALIZATION_REPAIR_DELAY_MS = 5 * 60 * 1_000;
const REPAIR_BATCH_SIZE = 20;
const REPAIR_LEASE_MS = 10 * 60 * 1_000;

export interface FinalizationRegistration {
  projectId: string;
  sessionId: string;
  orgId: string;
  objectId: string;
  shard: number;
  retentionDays: number;
  startedAt: number;
  now: number;
}

export interface FinalizationJob {
  project_id: string;
  session_id: string;
  org_id: string;
  object_id: string;
  shard: number;
  retention_days: number;
  started_at: number;
  state: "recording" | "ready" | "indexed";
  receipt_hash: string | null;
  ended_at: number | null;
  expires_at: number | null;
  analytics_sidecar_key: string | null;
  next_attempt_at: number;
  attempts: number;
  delete_analytics: number | null;
}

export interface FinalizationRepairRequest {
  projectId: string;
  sessionId: string;
  shard: number;
}

export interface FinalizationRepairResult {
  complete: boolean;
  nextAttemptAt: number;
}

/** Appended after existing billing statements, so changes() keeps its meaning. */
export function finalizationRegistrationStatements(
  db: D1Database,
  input: FinalizationRegistration,
): D1PreparedStatement[] {
  return [
    db
      .prepare(`INSERT INTO session_finalization_jobs (
      project_id, session_id, org_id, object_id, shard, retention_days,
      started_at, created_at, next_attempt_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, session_id) DO NOTHING`)
      .bind(
        input.projectId,
        input.sessionId,
        input.orgId,
        input.objectId,
        input.shard,
        input.retentionDays,
        input.startedAt,
        input.now,
        input.now + FINALIZATION_REPAIR_DELAY_MS,
      ),
    db
      .prepare(`SELECT object_id FROM session_finalization_jobs
      WHERE project_id = ? AND session_id = ? AND org_id = ?
        AND NOT EXISTS (SELECT 1 FROM session_deletions WHERE project_id = ? AND session_id = ?)`)
      .bind(input.projectId, input.sessionId, input.orgId, input.projectId, input.sessionId),
  ];
}

export function confirmFinalizationRegistration(
  result: D1Result | undefined,
  input: FinalizationRegistration,
): void {
  const row = result?.results[0];
  if (
    typeof row !== "object" ||
    row === null ||
    !("object_id" in row) ||
    row.object_id !== input.objectId
  ) {
    throw new Error("The session recovery record could not be saved.");
  }
}

export async function registerSessionFinalization(
  db: D1Database,
  input: FinalizationRegistration,
): Promise<void> {
  const results = await db.batch(finalizationRegistrationStatements(db, input));
  confirmFinalizationRegistration(results.at(-1), input);
}

export async function finalizationReceiptHash(message: FinalizeMessage): Promise<string> {
  const value = finalizeMessageSchema.parse(message);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function readFinalizationJob(
  db: D1Database,
  request: FinalizationRepairRequest,
): Promise<FinalizationJob | null> {
  return await db
    .prepare(`SELECT j.*, d.delete_analytics FROM session_finalization_jobs j
    LEFT JOIN session_deletions d ON d.project_id = j.project_id AND d.session_id = j.session_id
    WHERE j.project_id = ? AND j.session_id = ?`)
    .bind(request.projectId, request.sessionId)
    .first<FinalizationJob>();
}

export async function markFinalizationReady(
  db: D1Database,
  message: FinalizeMessage,
  objectId: string,
): Promise<void> {
  const hash = await finalizationReceiptHash(message);
  await db
    .prepare(`UPDATE session_finalization_jobs
    SET state = CASE WHEN state = 'indexed' THEN state ELSE 'ready' END,
      receipt_hash = ?, ended_at = ?, expires_at = ?, analytics_sidecar_key = ?, next_attempt_at = ?
    WHERE project_id = ? AND session_id = ? AND object_id = ?
      AND (receipt_hash IS NULL OR receipt_hash = ?)
      AND NOT EXISTS (SELECT 1 FROM session_deletions d
        WHERE d.project_id = session_finalization_jobs.project_id AND d.session_id = session_finalization_jobs.session_id
          AND d.delete_analytics = 1)`)
    .bind(
      hash,
      message.endedAt,
      message.endedAt + message.retentionDays * 86_400_000,
      message.analyticsSidecarKey ?? null,
      Date.now() + FINALIZATION_REPAIR_DELAY_MS,
      message.projectId,
      message.sessionId,
      objectId,
      hash,
    )
    .run();
  const job = await readFinalizationJob(db, message);
  if (job?.receipt_hash !== hash || job.object_id !== objectId || job.delete_analytics === 1) {
    throw new Error("The session finalization receipt could not be confirmed.");
  }
}

/** Must be the last statement in the index transaction, after the billing chain. */
export function confirmIndexedFinalizationStatement(
  db: D1Database,
  message: FinalizeMessage,
  hash: string,
): D1PreparedStatement {
  return db
    .prepare(`UPDATE session_finalization_jobs SET state = 'indexed', next_attempt_at = ?
    WHERE project_id = ? AND session_id = ? AND receipt_hash = ?
      AND NOT EXISTS (SELECT 1 FROM session_deletions d
        WHERE d.project_id = session_finalization_jobs.project_id AND d.session_id = session_finalization_jobs.session_id
          AND d.delete_analytics = 1)`)
    .bind(Date.now() + FINALIZATION_REPAIR_DELAY_MS, message.projectId, message.sessionId, hash);
}

/** Only called after index commit, presence removal, and styling dispatch. */
export async function acknowledgeSessionFinalization(
  env: Env,
  message: FinalizeMessage,
): Promise<void> {
  const db = shardDb(env, message.shard);
  const job = await readFinalizationJob(db, message);
  if (job === null || job.delete_analytics === 1) return;
  const hash = await finalizationReceiptHash(message);
  if (job.state !== "indexed" || job.receipt_hash !== hash) {
    throw new Error("The session index has not confirmed this finalization receipt.");
  }
  const stub = env.SESSION.get(env.SESSION.idFromString(job.object_id));
  await stub.acknowledgeFinalization({
    projectId: message.projectId,
    sessionId: message.sessionId,
    shard: message.shard,
    receiptHash: hash,
  });
  // Expired or deleted recordings still need their object cleanup, even if
  // they never obtained a sessions row. Their recovery record remains until then.
  await db
    .prepare(`DELETE FROM session_finalization_jobs WHERE project_id = ? AND session_id = ?
    AND state = 'indexed' AND receipt_hash = ? AND expires_at > ?
    AND NOT EXISTS (SELECT 1 FROM session_deletions d
      WHERE d.project_id = session_finalization_jobs.project_id AND d.session_id = session_finalization_jobs.session_id)`)
    .bind(message.projectId, message.sessionId, hash, Date.now())
    .run();
}

/** The registry survives Queue retries, DLQ expiry, and a missing DO alarm. */
export async function repairSessionFinalizations(env: Env, now = Date.now()): Promise<void> {
  const event = startWideEvent("worker", "consumer.finalization_repair", uuidv7());
  let repaired = 0;
  let failed = 0;
  let passFailed = false;
  try {
    const db = shardDb(env, 0);
    const jobs = await db
      .prepare(`SELECT j.*, d.delete_analytics FROM session_finalization_jobs j
      LEFT JOIN session_deletions d ON d.project_id = j.project_id AND d.session_id = j.session_id
      WHERE next_attempt_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY next_attempt_at, project_id, session_id LIMIT ?`)
      .bind(now, now, REPAIR_BATCH_SIZE)
      .all<FinalizationJob>();
    for (const job of jobs.results) {
      const owner = uuidv7();
      const claim = await db
        .prepare(`UPDATE session_finalization_jobs SET lease_owner = ?, lease_expires_at = ?
        WHERE project_id = ? AND session_id = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
        .bind(owner, now + REPAIR_LEASE_MS, job.project_id, job.session_id, now)
        .run();
      if (claim.meta.changes !== 1) continue;
      try {
        if (job.expires_at !== null && job.expires_at <= now && job.delete_analytics === null) {
          await recordAnalyticsErasureRequests(
            db,
            [
              {
                projectId: job.project_id,
                sessionId: job.session_id,
                startedAt: job.started_at,
                deleteReason: "recording_retention_expired",
                requiresWarehouseTombstone: 1,
              },
            ],
            now,
          );
        }
        const result = await env.SESSION.get(
          env.SESSION.idFromString(job.object_id),
        ).repairFinalization({
          projectId: job.project_id,
          sessionId: job.session_id,
          shard: job.shard,
        });
        if (result.complete) {
          await db
            .prepare(
              `DELETE FROM session_finalization_jobs WHERE project_id = ? AND session_id = ? AND lease_owner = ?`,
            )
            .bind(job.project_id, job.session_id, owner)
            .run();
        } else {
          await db
            .prepare(`UPDATE session_finalization_jobs SET next_attempt_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, last_error = NULL WHERE project_id = ? AND session_id = ? AND lease_owner = ?`)
            .bind(
              Math.max(now + FINALIZATION_REPAIR_DELAY_MS, result.nextAttemptAt),
              job.project_id,
              job.session_id,
              owner,
            )
            .run();
        }
        repaired += 1;
      } catch (error) {
        failed += 1;
        await db
          .prepare(`UPDATE session_finalization_jobs SET attempts = attempts + 1, next_attempt_at = ?,
          last_error = ?, lease_owner = NULL, lease_expires_at = NULL
          WHERE project_id = ? AND session_id = ? AND lease_owner = ?`)
          .bind(
            now +
              Math.min(3_600_000, FINALIZATION_REPAIR_DELAY_MS * 2 ** Math.min(job.attempts, 4)),
            (error instanceof Error ? error.message : "Session recovery failed.").slice(0, 500),
            job.project_id,
            job.session_id,
            owner,
          )
          .run();
      }
    }
  } catch (error) {
    passFailed = true;
    event.fail(error);
    throw error;
  } finally {
    event.set({ sessions_repaired: repaired, sessions_failed: failed });
    event.emit(failed === 0 && !passFailed ? "success" : "server_error");
  }
}
