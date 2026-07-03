import {
  finalizeMessageSchema,
  startWideEvent,
  type FinalizeMessage,
  type IndexEvent,
  type WideEventOutcome,
} from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
import {
  chunkList,
  durationMsFromTimes,
  expiresAtFromEndedAt,
  truncateEventDetail,
  usageMonthFromStartedAt,
} from "./helpers.ts";

const EVENT_INSERT_BATCH_SIZE = 100;

interface IndexSessionResult {
  inserted: boolean;
  eventsWritten: number;
}

export async function handleFinalizeBatch(
  batch: MessageBatch<FinalizeMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
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
  });

  try {
    if (!parsed.success) {
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
    message.ack();
  } catch (err) {
    outcome = "server_error";
    wideEvent.fail(err);
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  } finally {
    wideEvent.emit(outcome);
  }
}

export async function indexSession(
  env: Env,
  finalizeMessage: FinalizeMessage,
): Promise<IndexSessionResult> {
  const db = shardDb(env, finalizeMessage.shard);
  const expiresAt = expiresAtFromEndedAt(finalizeMessage.endedAt, finalizeMessage.retentionDays);
  const inserted = await db
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
      ON CONFLICT(session_id) DO NOTHING`,
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
      0,
      finalizeMessage.manifestKey,
      expiresAt,
    )
    .run();

  if (inserted.meta.changes === 0) {
    return { inserted: false, eventsWritten: 0 };
  }

  await db
    .prepare(
      `INSERT INTO usage_monthly (org_id, month, sessions, bytes)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(org_id, month) DO UPDATE SET
        sessions = sessions + 1,
        bytes = bytes + excluded.bytes`,
    )
    .bind(
      finalizeMessage.orgId,
      usageMonthFromStartedAt(finalizeMessage.startedAt),
      finalizeMessage.bytes,
    )
    .run();

  const eventsWritten = await insertSessionEvents(
    db,
    finalizeMessage.sessionId,
    finalizeMessage.events,
  );
  return { inserted: true, eventsWritten };
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** attempts, 3_600);
}

async function insertSessionEvents(
  db: D1Database,
  sessionId: string,
  events: readonly IndexEvent[],
): Promise<number> {
  let eventsWritten = 0;

  for (const chunk of chunkList(events, EVENT_INSERT_BATCH_SIZE)) {
    const statements = chunk.map((event) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO session_events (session_id, t, kind, detail)
          VALUES (?, ?, ?, ?)`,
        )
        .bind(sessionId, event.t, event.k, truncateEventDetail(event.d)),
    );
    const results = await db.batch(statements);
    for (const result of results) {
      eventsWritten += result.meta.changes;
    }
  }

  return eventsWritten;
}
