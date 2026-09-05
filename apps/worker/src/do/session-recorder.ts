import { startWideEvent } from "@orange-replay/shared";
import type { WideEventOutcome } from "@orange-replay/shared";
import { DurableObject } from "cloudflare:workers";
import { usageMonthFromStartedAt } from "../consumer/helpers.ts";
import { deleteSessionObjects } from "../consumer/sweeper.ts";
import {
  FINALIZATION_REPAIR_DELAY_MS,
  finalizationReceiptHash,
  markFinalizationReady,
  readFinalizationJob,
  registerSessionFinalization,
  type FinalizationRegistration,
  type FinalizationRepairRequest,
  type FinalizationRepairResult,
} from "../consumer/finalization-recovery.ts";
import type { Env } from "../env.ts";
import {
  acceptedUsageReservationsEnabled,
  devTestRoutesFlag,
  setWorkerLoggerVersion,
  shardDb,
} from "../env.ts";
import { reserveAcceptedUsage as reserveAcceptedUsageInD1 } from "../usage/accepted-usage.ts";
import type { AppendArgs, AppendResult } from "./contract.ts";
import { sendPresenceSessionRequest } from "./presence-client.ts";
import { resolvePresenceTiming, shouldSendPresencePing } from "./presence-logic.ts";
import { encodeStoredBatchMetadata, parseStoredBatchMetadata } from "./session-batch-metadata.ts";
import { createSessionFinalizeMetrics, SessionFinalizer } from "./session-finalizer.ts";
import { buildFinalizeTimelineData } from "./session-finalize-data.ts";
import { SessionLiveHub } from "./session-live-hub.ts";
import {
  beginFinalizing,
  lifecycleState,
  sessionIsClosed,
  sessionLifecycle,
} from "./session-lifecycle.ts";
import { clampIndexForStorage, shouldDropForSessionCap } from "./session-budgets.ts";
import { createFreshState, encodedTextBytes, updateStateWithBatch } from "./session-state.ts";
import { SessionAlarms } from "./session-alarms.ts";
import {
  decideSegmentFlush,
  liveAck,
  nextAlarmAfterAlarm,
  resolveSessionTiming,
  trackAppendRateLimit,
} from "./session-timing.ts";
import type { SessionState } from "./session-state.ts";
import type { AppendRateLimitState, SegmentFlushReason } from "./session-timing.ts";
import {
  SessionRecorderStore,
  type FinalizedTombstone,
  type TestSeedBatchesArgs,
} from "./session-recorder-store.ts";
import { SessionSegmentWriter, type SegmentFlushResult } from "./session-segment-writer.ts";

type SqlRowValue = ArrayBuffer | string | number | null;

interface SessionFenceRow {
  [key: string]: SqlRowValue;
  found: number;
}

interface DebugState {
  hasState: boolean;
  schemaReady: boolean;
  finalized: boolean;
  bufferedBytes: number;
  pendingBatches: number;
  segmentCount: number;
  stateBytes: number;
  alarmAt: number | null;
  firstRequestId?: string;
  websiteIds?: string[];
  tombstonePurgeAt?: number;
  finalizationRegistered: boolean;
  hasFinalizationReceipt: boolean;
}

export type { TestSeedBatchesArgs } from "./session-recorder-store.ts";

export class SessionRecorder extends DurableObject<Env> {
  private readonly store: SessionRecorderStore;
  private readonly segmentWriter: SessionSegmentWriter;
  private readonly liveHub: SessionLiveHub;
  private readonly finalizer: SessionFinalizer;
  private readonly alarms: SessionAlarms;
  private sessionState: SessionState | null = null;
  private finalizedTombstone: FinalizedTombstone | null = null;
  private activeFlush: Promise<SegmentFlushResult | null> | null = null;
  private activeFinalize: Promise<void> | null = null;
  private readonly appendRateLimit: AppendRateLimitState = { windowStartedAt: 0, count: 0 };
  private schemaReady = false;
  private finalizationRegistered = false;
  private finalizationCancelled = false;
  private registrationInFlight: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setWorkerLoggerVersion(env);
    this.store = new SessionRecorderStore(ctx.storage.sql);
    this.alarms = new SessionAlarms(ctx.storage);
    this.segmentWriter = new SessionSegmentWriter(this.store, env.RECORDINGS);
    this.liveHub = new SessionLiveHub({
      ctx,
      getLifecycle: () => this.lifecycle(),
      getSegmentRefs: () => this.store.segmentRefs(),
      getPendingBatchCount: () => this.store.pendingBatchCount(),
      getPendingBatches: () => this.pendingLiveBatches(),
      getLiveSnapshot: () => this.buildLiveSnapshot(),
      requestCheckpointOnNextAppend: () => this.requestCheckpointOnNextAppend(),
      consumeLiveTicket: (nonce, expiresAt, now) =>
        this.store.consumeLiveTicket(nonce, expiresAt, now),
    });
    this.finalizer = new SessionFinalizer({
      recordings: env.RECORDINGS,
      finalizeQueue: env.FINALIZE_QUEUE,
      store: this.store,
      segmentWriter: this.segmentWriter,
      getSessionState: () => this.sessionState,
      flushPendingBatches: async () => {
        await this.flushSegment("finalize");
      },
      acceptedUsageReservationsEnabled: acceptedUsageReservationsEnabled(env),
      reserveAcceptedUsage: (state, bytes) => this.reserveAcceptedUsage(state, bytes, "finalize"),
      markFinalizationReady: (message) =>
        markFinalizationReady(shardDb(env, message.shard), message, ctx.id.toString()),
      markPresenceFinalizing: (projectId, sessionId, requestId, finalizingAt) =>
        this.markPresenceFinalizing(projectId, sessionId, requestId, finalizingAt),
      finalizeViewers: (manifest) => this.liveHub.finalizeViewers(manifest),
      rememberTombstone: (tombstone) => {
        this.sessionState = null;
        this.finalizedTombstone = tombstone;
      },
      alarms: this.alarms,
    });
    void ctx.blockConcurrencyWhile(async () => {
      if (this.store.hasSchema()) {
        this.store.createSchema();
        this.schemaReady = true;
        const stored = this.store.loadStoredState();
        this.sessionState = stored.state;
        this.finalizedTombstone = stored.tombstone;
        this.finalizationRegistered = this.store.finalizationIsRegistered();
        this.finalizationCancelled = this.store.finalizationIsCancelled();
      }
      await this.alarms.load();
      if (this.sessionState !== null && this.finalizedTombstone === null) {
        const timing = resolveSessionTiming(devTestRoutesFlag(this.env), this.env.TEST_TIMINGS);
        const desiredAt = nextAlarmAfterAlarm({
          lastActivity: this.sessionState.lastActivity,
          pendingBatches: this.store.pendingBatchCount(),
          timing,
        });
        await this.alarms.scheduleOnBootIfMissing(desiredAt);
      }
    });
  }

  async ping(): Promise<string> {
    return "pong";
  }

  /** Internal RPC only. The namespace binding and stored object id identify this job. */
  async repairFinalization(request: FinalizationRepairRequest): Promise<FinalizationRepairResult> {
    const event = startWideEvent(
      "worker",
      "do.finalization_repair",
      this.sessionState?.firstRequestId ?? this.finalizedTombstone?.firstRequestId,
    );
    try {
      const result = await this.repairFinalizationNow(request);
      event.set({ complete: result.complete, next_attempt_at: result.nextAttemptAt });
      return result;
    } catch (error) {
      event.fail(error);
      throw error;
    } finally {
      event.set({
        project_id: request.projectId,
        session_id: request.sessionId,
        shard: request.shard,
      });
      event.emit();
    }
  }

  private async repairFinalizationNow(
    request: FinalizationRepairRequest,
  ): Promise<FinalizationRepairResult> {
    const db = shardDb(this.env, request.shard);
    const job = await readFinalizationJob(db, request);
    const nextAttemptAt = Date.now() + FINALIZATION_REPAIR_DELAY_MS;
    if (job === null) return { complete: this.sessionState === null, nextAttemptAt };
    if (job.object_id !== this.ctx.id.toString())
      throw new Error("The recovery record belongs to another session.");
    this.ensureSchema();

    if (job.delete_analytics === 1) {
      this.store.cancelFinalization();
      this.finalizationCancelled = true;
      for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Recording deleted.");
      // Stop admission first, then wait for any already-started R2 writes.
      // Deleting objects before those writes settle could recreate erased data.
      await this.activeFinalize?.catch(() => undefined);
      await this.activeFlush?.catch(() => undefined);
      const deletion = await deleteSessionObjects(
        this.env.RECORDINGS,
        {
          projectId: job.project_id,
          sessionId: job.session_id,
          startedAt: job.started_at,
          deleteReason: "delete_requested",
          requiresWarehouseTombstone: 1,
          keepAnalyticsSidecar: 0,
        },
        1,
      );
      if (deletion.complete) {
        await sendPresenceSessionRequest(this.env, "/remove", job.session_id, {
          projectId: job.project_id,
          sessionId: job.session_id,
        });
        await db
          .prepare("DELETE FROM accepted_usage_sessions WHERE project_id = ? AND session_id = ?")
          .bind(job.project_id, job.session_id)
          .run();
        await this.ctx.storage.deleteAll();
        this.sessionState = null;
        this.finalizedTombstone = null;
        this.schemaReady = false;
        this.finalizationRegistered = false;
      }
      return { complete: deletion.complete, nextAttemptAt };
    }

    const state = this.sessionState;
    if (state !== null) {
      await this.ensureFinalizationRegistered(state);
      const timing = resolveSessionTiming(devTestRoutesFlag(this.env), this.env.TEST_TIMINGS);
      if (state.finalizingAt !== undefined || Date.now() - state.lastActivity >= timing.closeMs) {
        await this.finalize();
      } else {
        const desiredAt = nextAlarmAfterAlarm({
          lastActivity: state.lastActivity,
          pendingBatches: this.store.pendingBatchCount(),
          timing,
        });
        await this.alarms.schedule(desiredAt, timing.flushTailMs);
        return { complete: false, nextAttemptAt: state.lastActivity + timing.closeMs };
      }
    } else {
      const receipt = this.store.readFinalizationReceipt();
      if (receipt !== null) {
        await markFinalizationReady(db, receipt, this.ctx.id.toString());
        await this.env.FINALIZE_QUEUE.send(receipt, { contentType: "json" });
      } else if (!this.store.finalizationIsComplete()) {
        throw new Error("The saved session finalization receipt is missing.");
      }
    }

    if (job.expires_at !== null && (job.expires_at <= Date.now() || job.delete_analytics === 0)) {
      const pending =
        job.state !== "indexed" ||
        (await db
          .prepare(`SELECT 1 AS pending FROM analytics_export_outbox
        WHERE project_id = ? AND session_id = ? AND record_kind = 'session' AND sent_at IS NULL LIMIT 1`)
          .bind(job.project_id, job.session_id)
          .first()) !== null;
      const deletion = await deleteSessionObjects(
        this.env.RECORDINGS,
        {
          projectId: job.project_id,
          sessionId: job.session_id,
          startedAt: job.started_at,
          deleteReason: "recording_retention_expired",
          requiresWarehouseTombstone: 1,
          keepAnalyticsSidecar: pending && job.analytics_sidecar_key !== null ? 1 : 0,
        },
        1,
      );
      return { complete: deletion.complete && this.store.finalizationIsComplete(), nextAttemptAt };
    }
    return { complete: this.store.finalizationIsComplete(), nextAttemptAt };
  }

  async acknowledgeFinalization(
    request: FinalizationRepairRequest & { receiptHash: string },
  ): Promise<void> {
    const event = startWideEvent(
      "worker",
      "do.finalization_ack",
      this.finalizedTombstone?.firstRequestId,
    );
    try {
      await this.acknowledgeFinalizationNow(request);
    } catch (error) {
      event.fail(error);
      throw error;
    } finally {
      event.set({ project_id: request.projectId, session_id: request.sessionId });
      event.emit();
    }
  }

  private async acknowledgeFinalizationNow(
    request: FinalizationRepairRequest & { receiptHash: string },
  ): Promise<void> {
    const job = await readFinalizationJob(shardDb(this.env, request.shard), request);
    if (job === null || job.delete_analytics === 1) return;
    if (
      job.object_id !== this.ctx.id.toString() ||
      job.state !== "indexed" ||
      job.receipt_hash !== request.receiptHash
    ) {
      throw new Error("The session index has not confirmed this finalization receipt.");
    }
    this.ensureSchema();
    const receipt = this.store.readFinalizationReceipt();
    if (receipt === null && this.store.finalizationIsComplete()) return;
    if (receipt === null || (await finalizationReceiptHash(receipt)) !== request.receiptHash) {
      throw new Error("The session finalization receipt does not match its acknowledgement.");
    }
    this.store.completeFinalizationReceipt();
  }

  private buildLiveSnapshot() {
    const state = this.sessionState;
    if (state === null) {
      return null;
    }

    const timelineData = buildFinalizeTimelineData(
      this.store.storedEventRows(),
      state.startedAt,
      state.lastActivity,
    );
    return {
      startedAt: state.startedAt,
      endedAt: state.lastActivity,
      durationMs: Math.max(0, state.lastActivity - state.startedAt),
      timeline: timelineData.timeline,
      ...(state.domMasking === undefined ? {} : { domMasking: state.domMasking }),
      counts: {
        batches: state.batchCount,
        ...timelineData.counts,
      },
    };
  }

  private pendingLiveBatches() {
    const state = this.sessionState;
    if (state === null) return [];

    return this.store.pendingBatchRows().map((row) => {
      const metadata = parseStoredBatchMetadata(row.events);
      return {
        index: {
          v: 1 as const,
          s: state.sessionId,
          tab: row.tab,
          seq: row.seq,
          t0: row.t0,
          t1: row.t1,
          e: metadata.events,
          ...(metadata.checkpointTimestamps.length === 0
            ? {}
            : { checkpointTimestamps: metadata.checkpointTimestamps }),
        },
        payload: new Uint8Array(row.body),
      };
    });
  }

  async appendBatch(args: AppendArgs): Promise<AppendResult> {
    const event = startWideEvent("worker", "do.append", args.requestId);
    const timing = resolveSessionTiming(devTestRoutesFlag(this.env), this.env.TEST_TIMINGS);
    let result: AppendResult = { ...liveAck(0, timing), closed: false };
    let outcome: WideEventOutcome = "success";
    let dropReason: "session_closed" | "session_cap" | undefined;
    let rateLimited = false;
    let duplicate = false;
    let flushReason: SegmentFlushReason | undefined;
    let viewerCount = 0;
    let bufferedBytes = this.sessionState?.bufferedBytes ?? 0;
    let presencePingError: string | undefined;
    let checkpoint = false;

    try {
      if (trackAppendRateLimit(this.appendRateLimit, args.receivedAt, timing)) {
        outcome = "rate_limited";
        rateLimited = true;
        viewerCount = this.liveHub.viewerCount();
        result = { ...liveAck(viewerCount, timing), closed: false, rateLimited: true };
        return result;
      }

      const closedResult = (): AppendResult => {
        outcome = "dropped";
        dropReason = "session_closed";
        return { ...liveAck(0, timing), closed: true };
      };

      const lifecycle = this.lifecycle();
      if (this.finalizationCancelled || sessionIsClosed(lifecycle)) {
        result = closedResult();
        return result;
      }

      let state = lifecycleState(lifecycle);
      if (state === null) {
        if (args.seq !== 0) {
          result = closedResult();
          return result;
        }

        if (
          (await this.segmentWriter.recordingExists(args.projectId, args.sessionId)) ||
          (await this.sessionIsDeletionFenced(args.projectId, args.sessionId, args.shard))
        ) {
          result = closedResult();
          return result;
        }

        this.ensureSchema();
        state = this.sessionState ?? createFreshState(args);
      }

      const clampedIndex = clampIndexForStorage(args.index, state.startedAt, args.receivedAt);
      const eventsJson = encodeStoredBatchMetadata(clampedIndex);
      const eventBytes = encodedTextBytes(eventsJson);
      duplicate = this.store.batchExists(args.tab, args.seq);
      viewerCount = this.liveHub.viewerCount();

      if (duplicate) {
        await this.ensureAcceptedUsageAndAlarm(state, timing.flushTailMs, true);
        result = { ...liveAck(viewerCount, timing), closed: false };
        return result;
      }

      if (
        shouldDropForSessionCap({
          totalPayloadBytes: state.totalPayloadBytes,
          totalEventBytes: state.totalEventBytes,
          batchCount: state.batchCount,
          segmentCount: state.segmentCount,
          payloadBytes: args.payload.byteLength,
          eventBytes,
        }) ||
        !this.segmentWriter.hasCapacityForBatch(state, {
          tab: args.tab,
          seq: args.seq,
          t0: clampedIndex.t0,
          t1: clampedIndex.t1,
          bytes: args.payload.byteLength,
          flags: args.flags,
          events: eventsJson,
          body: args.payload,
        })
      ) {
        outcome = "dropped";
        dropReason = "session_cap";
        result = { ...liveAck(viewerCount, timing), closed: false, drop: true };
        return result;
      }

      duplicate = !this.store.insertBatch({
        tab: args.tab,
        seq: args.seq,
        t0: clampedIndex.t0,
        t1: clampedIndex.t1,
        bytes: args.payload.byteLength,
        flags: args.flags,
        events: eventsJson,
        body: args.payload,
      });

      if (duplicate) {
        await this.ensureAcceptedUsageAndAlarm(state, timing.flushTailMs, true);
        result = { ...liveAck(viewerCount, timing), closed: false };
        return result;
      }

      updateStateWithBatch(state, args, clampedIndex, eventBytes);

      const presenceTiming = resolvePresenceTiming(
        devTestRoutesFlag(this.env),
        this.env.TEST_TIMINGS,
      );
      if (
        shouldSendPresencePing({
          lastPingAt: state.lastPresencePingAt,
          now: args.receivedAt,
          heartbeatMs: presenceTiming.heartbeatMs,
        })
      ) {
        state.lastPresencePingAt = args.receivedAt;
        presencePingError = this.queuePresencePing(state, args.requestId, args.receivedAt);
        if (presencePingError !== undefined) {
          delete state.lastPresencePingAt;
        }
      }

      checkpoint = state.checkpointRequested === true;
      if (checkpoint) {
        delete state.checkpointRequested;
      }

      this.persistSessionState(state);
      bufferedBytes = state.bufferedBytes;

      viewerCount = this.liveHub.broadcastBatch({ ...args, index: clampedIndex });

      const pendingBatches = this.store.pendingBatchCount();
      const flushDecision = decideSegmentFlush({
        bufferedBytes: state.bufferedBytes,
        pendingBatches,
        receivedAt: args.receivedAt,
        lastFlushAt: state.lastFlushAt,
        timing,
      });

      // The local batch write is already durable. Attempt the D1 reservation
      // and recovery alarm together so either service can repair the other on
      // a retry, without acknowledging uncharged accepted bytes.
      await this.ensureAcceptedUsageAndAlarm(state, timing.flushTailMs);

      if (flushDecision.shouldFlush && flushDecision.reason !== undefined) {
        const flushed = await this.flushSegment(flushDecision.reason);
        flushReason = flushed?.reason;
        bufferedBytes = this.sessionState?.bufferedBytes ?? 0;
        if (flushed !== null && acceptedUsageReservationsEnabled(this.env)) {
          await this.reserveCurrentAcceptedUsage(state, "append", true);
        }
      }

      viewerCount = this.liveHub.viewerCount();
      result = {
        ...liveAck(viewerCount, timing),
        closed: false,
        ...(checkpoint ? { checkpoint: true } : {}),
      };
      return result;
    } catch (err) {
      outcome = "server_error";
      event.fail(err);
      throw err;
    } finally {
      event.set({
        project_id: args.projectId,
        org_id: args.orgId,
        session_id: args.sessionId,
        tab: args.tab,
        seq: args.seq,
        bytes_in: args.payload.byteLength,
        buffered_bytes: bufferedBytes,
        viewer_count: viewerCount,
        duplicate,
        rate_limited: rateLimited,
      });
      if (checkpoint) {
        event.set({ checkpoint: true });
      }
      if (flushReason !== undefined) {
        event.set({ flush_reason: flushReason });
      }
      if (dropReason !== undefined) {
        event.set({ reason: dropReason });
      }
      if (presencePingError !== undefined) {
        event.set({ presence_ping_error: presencePingError });
      }
      event.emit(outcome);
    }
  }

  async debug(): Promise<DebugState> {
    const stateBytes = this.stateBytes();
    return {
      hasState: this.sessionState !== null,
      schemaReady: this.schemaReady,
      finalized: this.finalizedTombstone !== null,
      finalizationRegistered: this.finalizationRegistered,
      hasFinalizationReceipt: this.schemaReady && this.store.readFinalizationReceipt() !== null,
      bufferedBytes: this.sessionState?.bufferedBytes ?? 0,
      pendingBatches: this.schemaReady ? this.store.pendingBatchCount() : 0,
      segmentCount:
        this.sessionState?.segmentCount ?? (this.schemaReady ? this.store.segmentRows().length : 0),
      stateBytes,
      // Storage is the ground truth so tests catch a drifting mirror.
      alarmAt: await this.ctx.storage.getAlarm(),
      firstRequestId: this.sessionState?.firstRequestId ?? this.finalizedTombstone?.firstRequestId,
      ...(this.sessionState?.websiteIds === undefined
        ? {}
        : { websiteIds: this.sessionState.websiteIds }),
      ...(this.finalizedTombstone === null
        ? {}
        : { tombstonePurgeAt: this.finalizedTombstone.purgeAt }),
    };
  }

  async presencePingStateForTest(): Promise<{ lastPresencePingAt: number | null }> {
    return { lastPresencePingAt: this.sessionState?.lastPresencePingAt ?? null };
  }

  private stateBytes(): number {
    const value = this.sessionState ?? this.finalizedTombstone;
    return value === null ? 0 : new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  async seedBatchesForTest(args: TestSeedBatchesArgs): Promise<DebugState> {
    if (this.finalizedTombstone !== null) {
      return this.debug();
    }

    this.ensureSchema();
    this.sessionState = this.store.seedBatchesForTest(this.sessionState, args);
    return this.debug();
  }

  async flushForTest(): Promise<SegmentFlushResult | null> {
    return await this.flushSegment("tail_flush");
  }

  async finalizeForTest(): Promise<void> {
    await this.finalize();
  }

  async markFinalizingForTest(): Promise<void> {
    const state = this.sessionState;
    if (state === null) return;
    beginFinalizing(state, (updated) => this.persistSessionState(updated));
  }

  async alarmForTest(): Promise<void> {
    await this.alarm();
  }

  async removeAlarmForTest(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.alarms.onAlarmFired();
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const event = startWideEvent(
      "worker",
      "do.alarm",
      this.sessionState?.firstRequestId ?? this.finalizedTombstone?.firstRequestId,
    );
    const timing = resolveSessionTiming(devTestRoutesFlag(this.env), this.env.TEST_TIMINGS);
    let alarmKind: "tail_flush" | "close" | "purge_tombstone" | "noop" = "noop";
    let projectId = this.sessionState?.projectId ?? this.finalizedTombstone?.projectId;
    let orgId = this.sessionState?.orgId ?? this.finalizedTombstone?.orgId;
    let sessionId = this.sessionState?.sessionId ?? this.finalizedTombstone?.sessionId;

    try {
      this.alarms.onAlarmFired();
      const lifecycle = this.lifecycle();
      if (lifecycle.status === "finalized") {
        const receipt = this.store.readFinalizationReceipt();
        const identity =
          receipt ??
          (lifecycle.tombstone.projectId !== undefined &&
          lifecycle.tombstone.sessionId !== undefined
            ? {
                projectId: lifecycle.tombstone.projectId,
                sessionId: lifecycle.tombstone.sessionId,
                shard: 0,
              }
            : null);
        if (identity !== null) {
          const job = await readFinalizationJob(shardDb(this.env, identity.shard), identity);
          if (job !== null) {
            const repair = await this.repairFinalization(identity);
            if (!repair.complete) {
              await this.alarms.schedulePurge(Date.now() + FINALIZATION_REPAIR_DELAY_MS);
              return;
            }
            await shardDb(this.env, identity.shard)
              .prepare(
                "DELETE FROM session_finalization_jobs WHERE project_id = ? AND session_id = ? AND object_id = ?",
              )
              .bind(identity.projectId, identity.sessionId, this.ctx.id.toString())
              .run();
            if (!this.schemaReady) return;
          } else if (receipt !== null) {
            throw new Error(
              "The session recovery record is missing while its receipt is still pending.",
            );
          }
        }
        const purgeAt = lifecycle.tombstone.purgeAt;
        if (Date.now() >= purgeAt) {
          alarmKind = "purge_tombstone";
          await this.ctx.storage.deleteAll();
          this.sessionState = null;
          this.finalizedTombstone = null;
          this.schemaReady = false;
          this.finalizationRegistered = false;
          return;
        }

        await this.alarms.schedulePurge(purgeAt);
        return;
      }

      if (lifecycle.status === "empty") {
        return;
      }
      const state = lifecycle.state;
      await this.ensureFinalizationRegistered(state);
      projectId = state.projectId;
      orgId = state.orgId;
      sessionId = state.sessionId;
      // A previous finalization can finish indexing in D1 before this Durable
      // Object stores its tombstone. Resume that handoff as finalization. An
      // append reservation would treat the already closed D1 row as a late
      // write and make this alarm fail forever.
      if (lifecycle.status === "finalizing") {
        alarmKind = "close";
        if (acceptedUsageReservationsEnabled(this.env)) {
          await this.reserveCurrentAcceptedUsage(state, "finalize", true);
        }
        await this.finalize();
        return;
      }
      if (acceptedUsageReservationsEnabled(this.env)) {
        await this.reserveCurrentAcceptedUsage(state, "append", true);
      }

      const now = Date.now();
      const idleMs = now - state.lastActivity;

      if (idleMs >= timing.closeMs) {
        alarmKind = "close";
        await this.finalize();
        return;
      }

      if (idleMs >= timing.flushTailMs && this.store.pendingBatchCount() > 0) {
        alarmKind = "tail_flush";
        await this.flushSegment("tail_flush");
        if (this.sessionState !== null && acceptedUsageReservationsEnabled(this.env)) {
          await this.reserveCurrentAcceptedUsage(this.sessionState, "append", true);
        }
      }

      if (this.sessionState !== null) {
        const desiredAt = nextAlarmAfterAlarm({
          lastActivity: this.sessionState.lastActivity,
          pendingBatches: this.store.pendingBatchCount(),
          timing,
        });
        await this.alarms.schedule(desiredAt, timing.flushTailMs);
      }
    } catch (err) {
      event.fail(err);
      // Automatic alarm retries are finite. Keep a future wakeup as well as
      // the independent D1 repair record; constructor alarm handling stays unchanged.
      await this.alarms
        .schedulePurge(Date.now() + FINALIZATION_REPAIR_DELAY_MS)
        .catch(() => undefined);
      throw err;
    } finally {
      event.set({
        alarm_kind: alarmKind,
        alarm_is_retry: alarmInfo?.isRetry ?? false,
        alarm_retry_count: alarmInfo?.retryCount ?? 0,
        ...(projectId === undefined ? {} : { project_id: projectId }),
        ...(orgId === undefined ? {} : { org_id: orgId }),
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
      });
      event.emit();
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.sessionState !== null && !this.finalizationRegistered) {
      await this.ensureFinalizationRegistered(this.sessionState);
    }
    return await this.liveHub.fetch(request);
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.liveHub.webSocketMessage(ws, message);
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    this.liveHub.webSocketClose(ws, code, reason, wasClean);
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    this.liveHub.webSocketError(ws, error);
  }

  private requestCheckpointOnNextAppend(): void {
    const state = this.sessionState;
    if (state === null || state.checkpointRequested === true) {
      return;
    }

    state.checkpointRequested = true;
    this.persistSessionState(state);
  }

  private lifecycle() {
    return sessionLifecycle(this.sessionState, this.finalizedTombstone);
  }

  private persistSessionState(state: SessionState): void {
    this.sessionState = state;
    this.store.persistState(state);
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.store.createSchema();
    this.schemaReady = true;
  }

  private async sessionIsDeletionFenced(
    projectId: string,
    sessionId: string,
    shard: number,
  ): Promise<boolean> {
    const row = await shardDb(this.env, shard)
      .prepare(
        `SELECT 1 AS found FROM sessions WHERE project_id = ? AND session_id = ?
        UNION ALL
        SELECT 1 AS found FROM session_deletions WHERE project_id = ? AND session_id = ?
        LIMIT 1`,
      )
      .bind(projectId, sessionId, projectId, sessionId)
      .first<SessionFenceRow>();

    return row !== null;
  }

  private async flushSegment(reason: SegmentFlushReason): Promise<SegmentFlushResult | null> {
    if (this.activeFlush !== null) {
      return await this.activeFlush;
    }

    const flush = this.flushSegmentNow(reason);
    this.activeFlush = flush;
    try {
      return await flush;
    } finally {
      if (this.activeFlush === flush) {
        this.activeFlush = null;
      }
    }
  }

  private async flushSegmentNow(reason: SegmentFlushReason): Promise<SegmentFlushResult | null> {
    const state = this.sessionState;
    if (state === null || this.finalizationCancelled) {
      return null;
    }
    return await this.segmentWriter.flushSegment(state, reason);
  }

  private async ensureAcceptedUsageAndAlarm(
    state: SessionState,
    flushTailMs: number,
    verifyStoredBytes = false,
  ): Promise<void> {
    const operations: Promise<unknown>[] = [
      this.alarms.schedule(state.lastActivity + flushTailMs, flushTailMs),
    ];
    if (acceptedUsageReservationsEnabled(this.env)) {
      operations.push(this.reserveCurrentAcceptedUsage(state, "append", verifyStoredBytes));
    } else {
      operations.push(this.ensureFinalizationRegistered(state));
    }

    const results = await Promise.allSettled(operations);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
    if (this.finalizationCancelled)
      throw new Error("The recording was deleted before this batch was accepted.");
  }

  private async reserveCurrentAcceptedUsage(
    state: SessionState,
    source: "append" | "finalize",
    verifyStoredBytes = false,
  ): Promise<void> {
    await this.reserveAcceptedUsage(
      state,
      Math.max(
        state.totalPayloadBytes + state.totalEventBytes,
        verifyStoredBytes ? this.store.storedSegmentBytes() : 0,
        verifyStoredBytes ? this.store.storedAcceptedBytes() : 0,
      ),
      source,
    );
  }

  private async reserveAcceptedUsage(
    state: SessionState,
    bytes: number,
    source: "append" | "finalize",
  ): Promise<void> {
    const db = shardDb(this.env, state.shard);
    const reservation = {
      projectId: state.projectId,
      sessionId: state.sessionId,
      orgId: state.orgId,
      month: usageMonthFromStartedAt(state.startedAt),
      bytes,
      updatedAt: Date.now(),
      source,
    };
    if (!this.finalizationRegistered && this.registrationInFlight === null) {
      await this.runFinalizationRegistration(() =>
        reserveAcceptedUsageInD1(db, {
          ...reservation,
          finalizationRegistration: this.finalizationRegistration(state),
        }),
      );
      return;
    }
    if (this.registrationInFlight !== null) await this.registrationInFlight;
    await reserveAcceptedUsageInD1(db, reservation);
  }

  private finalizationRegistration(state: SessionState): FinalizationRegistration {
    return {
      projectId: state.projectId,
      sessionId: state.sessionId,
      orgId: state.orgId,
      objectId: this.ctx.id.toString(),
      shard: state.shard,
      retentionDays: state.retentionDays,
      startedAt: state.startedAt,
      now: Date.now(),
    };
  }

  private rememberFinalizationRegistration(): void {
    this.store.markFinalizationRegistered();
    this.finalizationRegistered = true;
  }

  private async ensureFinalizationRegistered(state: SessionState): Promise<void> {
    await this.runFinalizationRegistration(() =>
      registerSessionFinalization(
        shardDb(this.env, state.shard),
        this.finalizationRegistration(state),
      ),
    );
  }

  private async runFinalizationRegistration(operation: () => Promise<void>): Promise<void> {
    if (this.finalizationRegistered) return;
    if (this.registrationInFlight !== null) return await this.registrationInFlight;
    const pending = operation().then(() => this.rememberFinalizationRegistration());
    this.registrationInFlight = pending;
    try {
      await pending;
    } finally {
      if (this.registrationInFlight === pending) this.registrationInFlight = null;
    }
  }

  private async finalize(): Promise<void> {
    if (this.activeFinalize !== null) {
      return await this.activeFinalize;
    }

    const lifecycle = this.lifecycle();
    if (lifecycle.status === "empty" || lifecycle.status === "finalized") {
      return;
    }

    beginFinalizing(lifecycle.state, (updated) => this.persistSessionState(updated));
    // Own the complete operation before any awaited preflight can let an
    // alarm or repair request start another writer for this recording.
    const finalize = this.finalizeWithRecovery(lifecycle.state);
    this.activeFinalize = finalize;
    try {
      await finalize;
    } finally {
      if (this.activeFinalize === finalize) {
        this.activeFinalize = null;
      }
    }
  }

  private async finalizeWithRecovery(state: SessionState): Promise<void> {
    await this.ensureFinalizationRegistered(state);
    const job = await readFinalizationJob(shardDb(this.env, state.shard), state);
    if (job?.delete_analytics === 1 || this.finalizationCancelled) {
      this.store.cancelFinalization();
      this.finalizationCancelled = true;
      throw new Error("The recording was deleted before finalization.");
    }
    await this.finalizeNow();
  }

  private async finalizeNow(): Promise<void> {
    const stateBeforeFlush = this.sessionState;
    const event = startWideEvent("worker", "do.finalize", stateBeforeFlush?.firstRequestId);
    const metrics = createSessionFinalizeMetrics();

    try {
      await this.finalizer.finalize(metrics);
    } catch (err) {
      event.fail(err);
      throw err;
    } finally {
      event.set({
        ...(stateBeforeFlush === null
          ? {}
          : {
              project_id: stateBeforeFlush.projectId,
              org_id: stateBeforeFlush.orgId,
              session_id: stateBeforeFlush.sessionId,
            }),
        segments: metrics.segmentCount,
        bytes: metrics.bytes,
        batch_count: metrics.batchCount,
        timeline_events_dropped: metrics.timelineEventsDropped,
        rage_bursts: metrics.rageBursts,
        max_scroll_depth: metrics.maxScrollDepth,
        quick_backs: stateBeforeFlush?.quickBacks ?? 0,
        interaction_time_ms: metrics.interactionTimeMs,
      });
      if (metrics.presenceMarkError !== undefined) {
        event.set({ presence_mark_error: metrics.presenceMarkError });
      }
      event.emit();
    }
  }

  private queuePresencePing(
    state: SessionState,
    requestId: string,
    lastSeen: number,
  ): string | undefined {
    try {
      this.throwIfPresenceFailsForTest();
      const task = this.sendPresencePing(state, requestId, lastSeen);
      this.ctx.waitUntil(task);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  private async sendPresencePing(
    state: SessionState,
    requestId: string,
    lastSeen: number,
  ): Promise<void> {
    const event = startWideEvent("worker", "do.presence_ping", requestId);
    try {
      await sendPresenceSessionRequest(this.env, "/ping", requestId, {
        projectId: state.projectId,
        sessionId: state.sessionId,
        orgId: state.orgId,
        startedAt: state.startedAt,
        lastSeen,
        entryUrl: state.entryUrl ?? null,
        country: state.attrs.country ?? null,
        region: state.attrs.region ?? null,
        city: state.attrs.city ?? null,
        browser: state.attrs.browser ?? null,
        os: state.attrs.os ?? null,
        device: state.attrs.device ?? null,
        flags: state.flags,
        expiresAt: lastSeen + state.retentionDays * 86_400_000,
      });
    } catch (error) {
      event.fail(error);
      const current = this.sessionState;
      if (
        current !== null &&
        current.projectId === state.projectId &&
        current.sessionId === state.sessionId &&
        current.lastPresencePingAt === lastSeen
      ) {
        delete current.lastPresencePingAt;
        this.store.persistState(current);
      }
    } finally {
      event.set({
        project_id: state.projectId,
        org_id: state.orgId,
        session_id: state.sessionId,
        last_seen: lastSeen,
      });
      event.emit();
    }
  }

  private async markPresenceFinalizing(
    projectId: string,
    sessionId: string,
    requestId: string,
    finalizingAt: number,
  ): Promise<string | undefined> {
    try {
      this.throwIfPresenceFailsForTest();
      await sendPresenceSessionRequest(this.env, "/mark-finalizing", requestId, {
        projectId,
        sessionId,
        finalizingAt,
      });
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  private throwIfPresenceFailsForTest(): void {
    const timing = resolvePresenceTiming(devTestRoutesFlag(this.env), this.env.TEST_TIMINGS);
    if (timing.forceFailure) {
      throw new Error("presence registry is unavailable");
    }
  }
}

function errorMessage(error: unknown): string {
  return safeLogText(error instanceof Error ? error.message : String(error));
}

function safeLogText(value: string): string {
  return value.length <= 200 ? value : value.slice(0, 200);
}
