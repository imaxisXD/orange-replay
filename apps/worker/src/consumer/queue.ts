import {
  finalizeMessageSchema,
  startWideEvent,
  type FinalizeMessage,
  type WideEventOutcome,
} from "@orange-replay/shared";
import {
  analyticsExportEnabled,
  isDevTestMode,
  setWorkerLoggerVersion,
  shardDb,
  type Env,
} from "../env.ts";
import { chunkList, expiresAtFromEndedAt, usageMonthFromStartedAt } from "./helpers.ts";
import { buildFinalizeAnalyticsRecords } from "../analytics/export-record.ts";
import { maintainAnalyticsWarehouse } from "../analytics/maintenance.ts";
import { sendPresenceSessionRequest } from "../do/presence-client.ts";

const QUEUE_MAX_RETRIES = 10; // Must match wrangler.jsonc queue max_retries.
const SESSION_EVENT_INSERT_CHUNK_SIZE = 20;

interface IndexSessionResult {
  inserted: boolean;
  eventsWritten: number;
  exportsWritten: number;
}

export async function handleFinalizeBatch(
  batch: MessageBatch<FinalizeMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  setWorkerLoggerVersion(env);
  for (const message of batch.messages) {
    await handleFinalizeMessage(message, env);
  }
  // Finalization remains successful even when analytics delivery is down. The
  // durable outbox and five-minute cron safely retry the same stable records.
  if (analyticsExportEnabled(env)) {
    ctx.waitUntil(maintainAnalyticsWarehouse(env));
  }
}

async function handleFinalizeMessage(message: Message<FinalizeMessage>, env: Env): Promise<void> {
  const parsed = finalizeMessageSchema.safeParse(message.body);
  const wideEvent = startWideEvent(
    "worker",
    "consumer.finalize",
    parsed.success ? parsed.data.requestId : undefined,
  );
  let outcome: WideEventOutcome = "success";

  wideEvent.set({
    attempts: message.attempts,
    inserted: false,
    events_written: 0,
    exports_written: 0,
    dlq: false,
  });

  try {
    if (!parsed.success) {
      if (looksLikeFinalizeJob(message.body)) {
        const lastAllowedAttempt = message.attempts >= QUEUE_MAX_RETRIES;
        outcome = lastAllowedAttempt ? "dropped" : "server_error";
        wideEvent.set({ msg: "invalid finalize message", dlq: lastAllowedAttempt });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        return;
      }

      outcome = "client_error";
      wideEvent.set({ msg: "invalid finalize message" });
      message.ack();
      return;
    }

    const finalizeMessage = parsed.data;
    wideEvent.set({
      session_id: finalizeMessage.sessionId,
      project_id: finalizeMessage.projectId,
      org_id: finalizeMessage.orgId,
      shard: finalizeMessage.shard,
      attempts: message.attempts,
    });

    const result = await indexSession(env, finalizeMessage);
    wideEvent.set({
      inserted: result.inserted,
      events_written: result.eventsWritten,
      exports_written: result.exportsWritten,
    });
    // Do not acknowledge until the finalizing presence row is gone. D1 writes
    // are idempotent, so a temporary presence error can safely retry this job.
    await sendPresenceSessionRequest(env, "/remove", finalizeMessage.requestId, {
      projectId: finalizeMessage.projectId,
      sessionId: finalizeMessage.sessionId,
    });
    await writeFinalizeTraceForTest(env, finalizeMessage);
    message.ack();
  } catch (err) {
    const lastAllowedAttempt = message.attempts >= QUEUE_MAX_RETRIES;
    outcome = lastAllowedAttempt ? "dropped" : "server_error";
    wideEvent.fail(err);
    wideEvent.set({ dlq: lastAllowedAttempt });
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  } finally {
    wideEvent.emit(outcome);
  }
}

function looksLikeFinalizeJob(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "session.finalized" &&
    typeof (value as { manifestKey?: unknown }).manifestKey === "string"
  );
}

async function writeFinalizeTraceForTest(env: Env, message: FinalizeMessage): Promise<void> {
  if (!isDevTestMode(env)) {
    return;
  }

  await env.CONFIG.put(
    finalizeTraceKey(message.sessionId),
    JSON.stringify({
      requestId: message.requestId,
      projectId: message.projectId,
      orgId: message.orgId,
      sessionId: message.sessionId,
    }),
  );
}

export function finalizeTraceKey(sessionId: string): string {
  return `__test/finalize-request/${sessionId}`;
}

export async function indexSession(
  env: Env,
  finalizeMessage: FinalizeMessage,
): Promise<IndexSessionResult> {
  const exportEnabled = analyticsExportEnabled(env);
  if (exportEnabled && env.ANALYTICS_STREAM === undefined) {
    throw new Error("Analytics export is enabled, but its stream is not configured.");
  }
  const db = shardDb(env, finalizeMessage.shard);
  const expiresAt = expiresAtFromEndedAt(finalizeMessage.endedAt, finalizeMessage.retentionDays);
  const indexedAt = Date.now();
  const analyticsRecords = buildFinalizeAnalyticsRecords(finalizeMessage);
  const sessionRecord = analyticsRecords.session;
  const statements = [
    db
      .prepare(
        `INSERT INTO sessions (
          session_id,
          project_id,
          org_id,
          started_at,
          ended_at,
          duration_ms,
          country,
          region,
          city,
          device,
          browser,
          os,
          entry_url,
          url_count,
          page_count,
          analytics_version,
          max_scroll_depth,
          quick_backs,
          interaction_time_ms,
          activity_hist,
          clicks,
          errors,
          rages,
          navs,
          bytes,
          segment_count,
          flags,
          manifest_key,
          expires_at,
          indexed_at,
          has_checkpoint
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM session_deletions d
          WHERE d.project_id = ? AND d.session_id = ?
        )
        ON CONFLICT(project_id, session_id) DO NOTHING`,
      )
      .bind(
        sessionRecord.session_id,
        sessionRecord.project_id,
        sessionRecord.org_id,
        sessionRecord.started_at,
        sessionRecord.ended_at,
        sessionRecord.duration_ms,
        sessionRecord.country,
        sessionRecord.region,
        sessionRecord.city,
        sessionRecord.device,
        sessionRecord.browser,
        sessionRecord.os,
        sessionRecord.entry_url,
        sessionRecord.url_count,
        sessionRecord.page_count,
        sessionRecord.analytics_version,
        sessionRecord.max_scroll_depth,
        sessionRecord.quick_backs,
        sessionRecord.interaction_time_ms,
        sessionRecord.activity_hist,
        sessionRecord.clicks,
        sessionRecord.errors,
        sessionRecord.rages,
        sessionRecord.navs,
        sessionRecord.bytes,
        sessionRecord.segment_count,
        sessionRecord.flags,
        sessionRecord.manifest_key,
        expiresAt,
        indexedAt,
        finalizeMessage.hasCheckpoint === undefined ? null : Number(finalizeMessage.hasCheckpoint),
        sessionRecord.project_id,
        sessionRecord.session_id,
      ),
    db
      .prepare(
        `INSERT INTO usage_monthly (org_id, month, sessions, bytes)
        SELECT ?, ?, 1, ?
        WHERE (SELECT changes()) > 0
        ON CONFLICT(org_id, month) DO UPDATE SET
          sessions = sessions + 1,
          bytes = bytes + excluded.bytes`,
      )
      .bind(
        finalizeMessage.orgId,
        usageMonthFromStartedAt(finalizeMessage.startedAt),
        finalizeMessage.bytes,
      ),
  ];

  const eventStatementIndexes: number[] = [];
  if (analyticsRecords.events.length > 0) {
    for (const eventChunk of chunkList(analyticsRecords.events, SESSION_EVENT_INSERT_CHUNK_SIZE)) {
      const eventValues = eventChunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
      eventStatementIndexes.push(statements.length);
      statements.push(
        db
          .prepare(
            `WITH incoming(project_id, session_id, t, kind, detail) AS (
            VALUES ${eventValues}
          )
          INSERT OR IGNORE INTO session_events (project_id, session_id, t, kind, detail)
          SELECT project_id, session_id, t, kind, detail
          FROM incoming
          WHERE (SELECT changes()) > 0`,
          )
          .bind(
            ...eventChunk.flatMap((event) => [
              event.project_id,
              event.session_id,
              event.event_time,
              event.event_kind,
              event.event_detail,
            ]),
          ),
      );
    }
  }

  let outboxStatementIndex: number | null = null;
  if (exportEnabled) {
    outboxStatementIndex = statements.length;
    const outboxRows = analyticsRecords.serialized.map((record) => ({
      export_id: record.exportId,
      project_id: record.projectId,
      session_id: record.sessionId,
      record_kind: record.recordKind,
      payload_json: record.payloadJson,
    }));
    statements.push(
      db
        .prepare(
          `WITH incoming AS (
            SELECT
              key AS record_order,
              json_extract(value, '$.export_id') AS export_id,
            json_extract(value, '$.project_id') AS project_id,
            json_extract(value, '$.session_id') AS session_id,
            json_extract(value, '$.record_kind') AS record_kind,
            json_extract(value, '$.payload_json') AS payload_json
          FROM json_each(?)
        )
        INSERT OR IGNORE INTO analytics_export_outbox (
          export_id, project_id, session_id, record_kind, payload_json, created_at
        )
        SELECT export_id, project_id, session_id, record_kind, payload_json, ?
        FROM incoming
        WHERE NOT EXISTS (
          SELECT 1 FROM session_deletions d
          WHERE d.project_id = incoming.project_id AND d.session_id = incoming.session_id
        )
          AND EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = incoming.project_id
              AND p.jurisdiction IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM analytics_export_ledger l
            WHERE l.export_id = incoming.export_id
          )
        ORDER BY CAST(record_order AS INTEGER)`,
        )
        .bind(JSON.stringify(outboxRows), Date.now()),
    );
  }

  const results = await db.batch(statements);
  const inserted = results[0]?.meta.changes ?? 0;
  const eventsWritten = eventStatementIndexes.reduce(
    (total, statementIndex) => total + (results[statementIndex]?.meta.changes ?? 0),
    0,
  );
  const exportsWritten =
    outboxStatementIndex === null ? 0 : (results[outboxStatementIndex]?.meta.changes ?? 0);

  return {
    inserted: inserted > 0,
    eventsWritten,
    exportsWritten,
  };
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** attempts, 3_600);
}
