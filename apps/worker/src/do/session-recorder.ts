import { startWideEvent } from "@orange-replay/shared";
import type { WideEventOutcome } from "@orange-replay/shared";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { devTestRoutesFlag, setWorkerLoggerVersion, shardDb } from "../env.ts";
import type { AppendArgs, AppendResult } from "./contract.ts";
import { sendPresenceSessionRequest } from "./presence-client.ts";
import { resolvePresenceTiming, shouldSendPresencePing } from "./presence-logic.ts";
import { parseStoredBatchMetadata } from "./session-batch-metadata.ts";
import { createSessionFinalizeMetrics, SessionFinalizer } from "./session-finalizer.ts";
import { buildFinalizeTimelineData } from "./session-finalize-data.ts";
import { SessionLiveHub } from "./session-live-hub.ts";
import {
  clampIndexForStorage,
  createFreshState,
  decideSegmentFlush,
  encodeStoredBatchMetadata,
  encodedTextBytes,
  nextAlarmAfterAlarm,
  resolveSessionTiming,
  shouldDropForSessionCap,
  shouldSetAlarm,
  sdkFlushMs,
  trackAppendRateLimit,
  updateStateWithBatch,
} from "./session-logic.ts";
import type { AppendRateLimitState, SegmentFlushReason, SessionState } from "./session-logic.ts";
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
  finalized: boolean;
  bufferedBytes: number;
  pendingBatches: number;
  segmentCount: number;
  stateBytes: number;
  firstRequestId?: string;
  tombstonePurgeAt?: number;
}

export type { TestSeedBatchesArgs } from "./session-recorder-store.ts";

export class SessionRecorder extends DurableObject<Env> {
  private readonly store: SessionRecorderStore;
  private readonly segmentWriter: SessionSegmentWriter;
  private readonly liveHub: SessionLiveHub;
  private readonly finalizer: SessionFinalizer;
  private sessionState: SessionState | null = null;
  private finalizedTombstone: FinalizedTombstone | null = null;
  private alarmAt: number | null = null;
  private activeFlush: Promise<SegmentFlushResult | null> | null = null;
  private activeFinalize: Promise<void> | null = null;
  private readonly appendRateLimit: AppendRateLimitState = { windowStartedAt: 0, count: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setWorkerLoggerVersion(env);
    this.store = new SessionRecorderStore(ctx.storage.sql);
    this.segmentWriter = new SessionSegmentWriter(this.store, env.RECORDINGS);
    this.store.createSchema();
    this.liveHub = new SessionLiveHub({
      ctx,
      getSessionState: () => this.sessionState,
      getSegmentRefs: () => this.store.segmentRefs(),
      getPendingBatchCount: () => this.store.pendingBatchCount(),
      getPendingBatches: () => this.pendingLiveBatches(),
      getLiveSnapshot: () => this.buildLiveSnapshot(),
      requestCheckpointOnNextAppend: () => this.requestCheckpointOnNextAppend(),
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
      markPresenceFinalizing: (projectId, sessionId, requestId, finalizingAt) =>
        this.markPresenceFinalizing(projectId, sessionId, requestId, finalizingAt),
      finalizeViewers: (manifest) => this.liveHub.finalizeViewers(manifest),
      rememberTombstone: (tombstone) => {
        this.sessionState = null;
        this.finalizedTombstone = tombstone;
      },
      scheduleTombstonePurge: async (purgeAt) => {
        await ctx.storage.setAlarm(purgeAt);
        this.alarmAt = purgeAt;
      },
    });
    void ctx.blockConcurrencyWhile(async () => {
      const stored = this.store.loadStoredState();
      this.sessionState = stored.state;
      this.finalizedTombstone = stored.tombstone;
      this.alarmAt = await ctx.storage.getAlarm();
    });
  }

  async ping(): Promise<string> {
    return "pong";
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
    let result: AppendResult = { live: false, closed: false, flushMs: sdkFlushMs(false, timing) };
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
      let state = this.sessionState;
      if (this.finalizedTombstone !== null) {
        outcome = "dropped";
        dropReason = "session_closed";
        result = { live: false, closed: true, flushMs: sdkFlushMs(false, timing) };
        return result;
      }

      if (state?.finalizingAt !== undefined) {
        outcome = "dropped";
        dropReason = "session_closed";
        result = { live: false, closed: true, flushMs: sdkFlushMs(false, timing) };
        return result;
      }

      if (state === null) {
        if (args.seq !== 0) {
          outcome = "dropped";
          dropReason = "session_closed";
          result = { live: false, closed: true, flushMs: sdkFlushMs(false, timing) };
          return result;
        }

        if (
          (await this.segmentWriter.recordingExists(args.projectId, args.sessionId)) ||
          (await this.sessionIsDeletionFenced(args.projectId, args.sessionId, args.shard))
        ) {
          outcome = "dropped";
          dropReason = "session_closed";
          result = { live: false, closed: true, flushMs: sdkFlushMs(false, timing) };
          return result;
        }

        state = this.sessionState ?? createFreshState(args);
      }

      const clampedIndex = clampIndexForStorage(args.index, state.startedAt, args.receivedAt);
      const eventsJson = encodeStoredBatchMetadata(clampedIndex);
      const eventBytes = encodedTextBytes(eventsJson);
      duplicate = this.store.batchExists(args.tab, args.seq);
      viewerCount = this.liveHub.viewerCount();

      if (duplicate) {
        result = {
          live: viewerCount > 0,
          closed: false,
          flushMs: sdkFlushMs(viewerCount > 0, timing),
        };
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
        })
      ) {
        outcome = "dropped";
        dropReason = "session_cap";
        result = {
          live: viewerCount > 0,
          closed: false,
          flushMs: sdkFlushMs(viewerCount > 0, timing),
          drop: true,
        };
        return result;
      }

      if (trackAppendRateLimit(this.appendRateLimit, args.receivedAt, timing)) {
        outcome = "rate_limited";
        rateLimited = true;
        result = {
          live: viewerCount > 0,
          closed: false,
          flushMs: sdkFlushMs(viewerCount > 0, timing),
          rateLimited: true,
        };
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
        result = {
          live: viewerCount > 0,
          closed: false,
          flushMs: sdkFlushMs(viewerCount > 0, timing),
        };
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

      this.sessionState = state;
      this.store.persistState(state);
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

      await this.setAlarmIfUseful(state.lastActivity + timing.flushTailMs, timing.flushTailMs);

      if (flushDecision.shouldFlush && flushDecision.reason !== undefined) {
        const flushed = await this.flushSegment(flushDecision.reason);
        flushReason = flushed?.reason;
        bufferedBytes = this.sessionState?.bufferedBytes ?? 0;
      }

      viewerCount = this.liveHub.viewerCount();
      result = {
        live: viewerCount > 0,
        closed: false,
        flushMs: sdkFlushMs(viewerCount > 0, timing),
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
      finalized: this.finalizedTombstone !== null,
      bufferedBytes: this.sessionState?.bufferedBytes ?? 0,
      pendingBatches: this.store.pendingBatchCount(),
      segmentCount: this.sessionState?.segmentCount ?? this.store.segmentRows().length,
      stateBytes,
      firstRequestId: this.sessionState?.firstRequestId ?? this.finalizedTombstone?.firstRequestId,
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

    this.sessionState = this.store.seedBatchesForTest(this.sessionState, args);
    return this.debug();
  }

  async flushForTest(): Promise<SegmentFlushResult | null> {
    return await this.flushSegment("tail_flush");
  }

  async finalizeForTest(): Promise<void> {
    await this.finalize();
  }

  override async alarm(): Promise<void> {
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
      this.alarmAt = null;
      if (this.finalizedTombstone !== null) {
        const purgeAt = this.finalizedTombstone.purgeAt;
        if (Date.now() >= purgeAt) {
          alarmKind = "purge_tombstone";
          await this.ctx.storage.deleteAll();
          this.sessionState = null;
          this.finalizedTombstone = null;
          this.alarmAt = null;
          this.store.createSchema();
          return;
        }

        await this.setAlarmIfUseful(purgeAt, timing.flushTailMs);
        return;
      }

      const state = this.sessionState;
      if (state === null) {
        return;
      }
      projectId = state.projectId;
      orgId = state.orgId;
      sessionId = state.sessionId;

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
      }

      if (this.sessionState !== null) {
        const desiredAt = nextAlarmAfterAlarm({
          lastActivity: this.sessionState.lastActivity,
          pendingBatches: this.store.pendingBatchCount(),
          timing,
        });
        await this.setAlarmIfUseful(desiredAt, timing.flushTailMs);
      }
    } catch (err) {
      event.fail(err);
      throw err;
    } finally {
      event.set({
        alarm_kind: alarmKind,
        ...(projectId === undefined ? {} : { project_id: projectId }),
        ...(orgId === undefined ? {} : { org_id: orgId }),
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
      });
      event.emit();
    }
  }

  override async fetch(request: Request): Promise<Response> {
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
    this.sessionState = state;
    this.store.persistState(state);
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
    if (state === null) {
      return null;
    }
    return await this.segmentWriter.flushSegment(state, reason);
  }

  private async setAlarmIfUseful(desiredAt: number, flushTailMs: number): Promise<void> {
    const now = Date.now();
    if (shouldSetAlarm({ alarmAt: this.alarmAt, now, desiredAt, flushTailMs })) {
      await this.ctx.storage.setAlarm(desiredAt);
      this.alarmAt = desiredAt;
    }
  }

  private async finalize(): Promise<void> {
    if (this.activeFinalize !== null) {
      return await this.activeFinalize;
    }

    const state = this.sessionState;
    if (state === null || this.finalizedTombstone !== null) {
      return;
    }

    if (state.finalizingAt === undefined) {
      state.finalizingAt = Date.now();
      this.sessionState = state;
      this.store.persistState(state);
    }

    const finalize = this.finalizeNow();
    this.activeFinalize = finalize;
    try {
      await finalize;
    } finally {
      if (this.activeFinalize === finalize) {
        this.activeFinalize = null;
      }
    }
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
