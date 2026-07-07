import {
  finalizeMessageSchema,
  startWideEvent,
  type FinalizeMessage,
  type WideEventOutcome,
} from "@orange-replay/shared";
import { isDevTestMode, setWorkerLoggerVersion, shardDb, type Env } from "../env.ts";
import {
  durationMsFromTimes,
  expiresAtFromEndedAt,
  truncateEventDetail,
  usageMonthFromStartedAt,
} from "./helpers.ts";

const QUEUE_MAX_RETRIES = 10; // Must match wrangler.jsonc queue max_retries.

interface IndexSessionResult {
  inserted: boolean;
  eventsWritten: number;
}

export async function handleFinalizeBatch(
  batch: MessageBatch<FinalizeMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  setWorkerLoggerVersion(env);
  for (const message of batch.messages) {
    await handleFinalizeMessage(message, env);
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
  const db = shardDb(env, finalizeMessage.shard);
  const expiresAt = expiresAtFromEndedAt(finalizeMessage.endedAt, finalizeMessage.retentionDays);
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
          clicks,
          errors,
          rages,
          navs,
          bytes,
          segment_count,
          flags,
          manifest_key,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, session_id) DO NOTHING`,
      )
      .bind(
        finalizeMessage.sessionId,
        finalizeMessage.projectId,
        finalizeMessage.orgId,
        finalizeMessage.startedAt,
        finalizeMessage.endedAt,
        durationMsFromTimes(finalizeMessage.startedAt, finalizeMessage.endedAt),
        finalizeMessage.attrs.country ?? null,
        finalizeMessage.attrs.region ?? null,
        finalizeMessage.attrs.city ?? null,
        finalizeMessage.attrs.device ?? null,
        finalizeMessage.attrs.browser ?? null,
        finalizeMessage.attrs.os ?? null,
        finalizeMessage.attrs.entryUrl ?? null,
        finalizeMessage.attrs.urlCount ?? 0,
        finalizeMessage.counts.clicks,
        finalizeMessage.counts.errors,
        finalizeMessage.counts.rages,
        finalizeMessage.counts.navs,
        finalizeMessage.bytes,
        finalizeMessage.segments,
        finalizeMessage.flags,
        finalizeMessage.manifestKey,
        expiresAt,
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

  if (finalizeMessage.events.length > 0) {
    const eventValues = finalizeMessage.events.map(() => "(?, ?, ?, ?, ?)").join(", ");
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
          ...finalizeMessage.events.flatMap((event) => [
            finalizeMessage.projectId,
            finalizeMessage.sessionId,
            event.t,
            event.k,
            truncateEventDetail(event.d),
          ]),
        ),
    );
  }

  const results = await db.batch(statements);
  const inserted = results[0]?.meta.changes ?? 0;
  const eventsWritten = results[2]?.meta.changes ?? 0;

  return {
    inserted: inserted > 0,
    eventsWritten,
  };
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** attempts, 3_600);
}
