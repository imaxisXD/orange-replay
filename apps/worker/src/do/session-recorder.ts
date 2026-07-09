import {
  buildSegment,
  encodeIngestBody,
  finalizeMessageSchema,
  HDR_REQUEST_ID,
  MAX_LIVE_VIEWERS_PER_SESSION,
  MAX_MANIFEST_SEGMENTS,
  manifestKey,
  segmentKey,
  sessionManifestSchema,
  startWideEvent,
  uuidv7,
} from "@orange-replay/shared";
import type {
  EdgeAttrs,
  FinalizeMessage,
  IndexEvent,
  SegmentRef,
  WideEventOutcome,
} from "@orange-replay/shared";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { devTestRoutesFlag, setWorkerLoggerVersion, shardDb } from "../env.ts";
import type { AppendArgs, AppendResult } from "./contract.ts";
import { sendPresenceSessionRequest } from "./presence-client.ts";
import { resolvePresenceTiming, shouldSendPresencePing } from "./presence-logic.ts";
import {
  buildSessionManifest,
  capFinalizeMessageToBudget,
  capTimelineEventsToBudget,
  chunkForSegments,
  clampIndexForStorage,
  countTimelineEvents,
  decideSegmentFlush,
  filterFinalizeEvents,
  MAX_MANIFEST_TIMELINE_EVENTS,
  nextAlarmAfterAlarm,
  resolveSessionTiming,
  shouldDropForSessionCap,
  shouldSetAlarm,
  sdkFlushMs,
  trackAppendRateLimit,
} from "./session-logic.ts";
import type { SegmentFlushReason, SegmentForManifest, SessionState } from "./session-logic.ts";
import type { AppendRateLimitState } from "./session-logic.ts";

type SqlRowValue = ArrayBuffer | string | number | null;
const utf8Encoder = new TextEncoder();

interface StateRow {
  [key: string]: SqlRowValue;
  v: string;
}

interface BatchRow {
  [key: string]: SqlRowValue;
  tab: string;
  seq: number;
  t0: number;
  t1: number;
  bytes: number;
  flags: number;
  events: string;
  body: ArrayBuffer;
}

interface CountRow {
  [key: string]: SqlRowValue;
  count: number;
}

interface SessionFenceRow {
  [key: string]: SqlRowValue;
  found: number;
}

interface SegmentRow {
  [key: string]: SqlRowValue;
  n: number;
  key: string;
  bytes: number;
  t0: number;
  t1: number;
  batches: number;
  events: string;
}

interface SegmentIntentRow extends SegmentRow {
  rows_json: string;
  body: ArrayBuffer;
  batch_bytes: number;
}

interface SegmentIntentBatchRef {
  tab: string;
  seq: number;
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

interface SegmentFlushResult {
  reason: SegmentFlushReason;
  bytes: number;
  batches: number;
}

interface SegmentIntent {
  n: number;
  key: string;
  bytes: number;
  t0: number;
  t1: number;
  batches: number;
  events: string;
  rows: SegmentIntentBatchRef[];
  body: Uint8Array;
  batchBytes: number;
}

export interface TestSeedBatchesArgs {
  requestId: string;
  projectId: string;
  orgId: string;
  shard: number;
  retentionDays: number;
  sessionId: string;
  tab: string;
  startSeq: number;
  count: number;
  payloadBytes: number;
  t0: number;
  receivedAt: number;
  flags: number;
  attrs: EdgeAttrs;
}

interface FinalizedTombstone {
  finalized: true;
  finalizedAt: number;
  purgeAt: number;
  firstRequestId: string;
  projectId?: string;
  orgId?: string;
  sessionId?: string;
}

interface LiveSocketContext {
  requestId?: string;
  projectId?: string;
  sessionId?: string;
}

export class SessionRecorder extends DurableObject<Env> {
  private sessionState: SessionState | null = null;
  private finalizedTombstone: FinalizedTombstone | null = null;
  private alarmAt: number | null = null;
  private activeFlush: Promise<SegmentFlushResult | null> | null = null;
  private readonly appendRateLimit: AppendRateLimitState = { windowStartedAt: 0, count: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setWorkerLoggerVersion(env);
    this.createSchema();
    void ctx.blockConcurrencyWhile(async () => {
      const stored = this.loadStoredState();
      this.sessionState = stored.state;
      this.finalizedTombstone = stored.tombstone;
      this.alarmAt = await ctx.storage.getAlarm();
    });
  }

  async ping(): Promise<string> {
    return "pong";
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

      if (state === null) {
        if (args.seq !== 0) {
          outcome = "dropped";
          dropReason = "session_closed";
          result = { live: false, closed: true, flushMs: sdkFlushMs(false, timing) };
          return result;
        }

        if (
          (await this.recordingExists(args.projectId, args.sessionId)) ||
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
      const eventsJson = JSON.stringify(clampedIndex.e);
      const eventBytes = encodedBytes(eventsJson);
      duplicate = this.batchExists(args.tab, args.seq);
      viewerCount = this.ctx.getWebSockets("viewer").length;

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

      const insert = this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO batches
          (tab, seq, t0, t1, bytes, flags, events, body)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args.tab,
        args.seq,
        clampedIndex.t0,
        clampedIndex.t1,
        args.payload.byteLength,
        args.flags,
        eventsJson,
        exactArrayBuffer(args.payload),
      );
      duplicate = insert.rowsWritten === 0;

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
      }

      checkpoint = state.checkpointRequested === true;
      if (checkpoint) {
        delete state.checkpointRequested;
      }

      this.sessionState = state;
      this.persistState(state);
      bufferedBytes = state.bufferedBytes;

      viewerCount = this.broadcastBatch({ ...args, index: clampedIndex });

      const pendingBatches = this.pendingBatchCount();
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

      viewerCount = this.ctx.getWebSockets("viewer").length;
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
      pendingBatches: this.pendingBatchCount(),
      segmentCount: this.sessionState?.segmentCount ?? this.segmentRows().length,
      stateBytes,
      firstRequestId: this.sessionState?.firstRequestId ?? this.finalizedTombstone?.firstRequestId,
      ...(this.finalizedTombstone === null
        ? {}
        : { tombstonePurgeAt: this.finalizedTombstone.purgeAt }),
    };
  }

  private stateBytes(): number {
    const value = this.sessionState ?? this.finalizedTombstone;
    return value === null ? 0 : new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  async seedBatchesForTest(args: TestSeedBatchesArgs): Promise<DebugState> {
    if (this.finalizedTombstone !== null) {
      return this.debug();
    }

    let state = this.sessionState;
    if (state === null) {
      state = createFreshState({
        ...args,
        seq: args.startSeq,
        index: testIndex(args.sessionId, args.tab, args.startSeq, args.t0),
        payload: makeTestPayload(args.payloadBytes, args.startSeq),
      });
    }

    for (let offset = 0; offset < args.count; offset += 1) {
      const seq = args.startSeq + offset;
      if (this.batchExists(args.tab, seq)) {
        continue;
      }

      const payload = makeTestPayload(args.payloadBytes, seq);
      const index = clampIndexForStorage(
        testIndex(args.sessionId, args.tab, seq, args.t0 + offset),
        state.startedAt,
        args.receivedAt,
      );
      const eventsJson = JSON.stringify(index.e);

      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO batches
          (tab, seq, t0, t1, bytes, flags, events, body)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args.tab,
        seq,
        index.t0,
        index.t1,
        payload.byteLength,
        args.flags,
        eventsJson,
        exactArrayBuffer(payload),
      );

      updateStateWithBatch(
        state,
        { ...args, seq, index, payload },
        index,
        encodedBytes(eventsJson),
      );
    }

    this.sessionState = state;
    this.persistState(state);
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
          this.createSchema();
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

      if (idleMs >= timing.flushTailMs && this.pendingBatchCount() > 0) {
        alarmKind = "tail_flush";
        await this.flushSegment("tail_flush");
      }

      if (this.sessionState !== null) {
        const desiredAt = nextAlarmAfterAlarm({
          lastActivity: this.sessionState.lastActivity,
          pendingBatches: this.pendingBatchCount(),
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
    const url = new URL(request.url);
    const requestId = request.headers.get(HDR_REQUEST_ID) ?? uuidv7();
    const event = startWideEvent("worker", "do.live_connect", requestId);
    const wantsLiveSocket =
      url.pathname.endsWith("/live") &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket";
    let statusCode = 500;
    let outcome: WideEventOutcome = "server_error";
    let viewerCount = this.ctx.getWebSockets("viewer").length;
    const pathIds = livePathIds(url.pathname);
    let projectId = this.sessionState?.projectId ?? pathIds?.projectId;
    let sessionId = this.sessionState?.sessionId ?? pathIds?.sessionId;

    try {
      if (!wantsLiveSocket || this.sessionState === null) {
        const response = Response.json({ error: "not_found" }, { status: 404 });
        statusCode = response.status;
        outcome = "client_error";
        return response;
      }

      projectId = this.sessionState.projectId;
      sessionId = this.sessionState.sessionId;
      if (viewerCount >= MAX_LIVE_VIEWERS_PER_SESSION) {
        const response = Response.json({ error: "viewer_limit" }, { status: 429 });
        statusCode = response.status;
        outcome = "rate_limited";
        return response;
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ["viewer"]);
      server.serializeAttachment({
        requestId,
        projectId,
        sessionId,
      } satisfies LiveSocketContext);
      this.requestCheckpointOnNextAppend();
      viewerCount = this.ctx.getWebSockets("viewer").length;
      server.send(
        JSON.stringify({
          type: "hello",
          sessionId: this.sessionState.sessionId,
          startedAt: this.sessionState.startedAt,
          segments: this.segmentRefs(),
          pendingBatches: this.pendingBatchCount(),
        }),
      );

      statusCode = 101;
      outcome = "success";
      return new Response(null, { status: statusCode, webSocket: client });
    } catch (error) {
      event.fail(error);
      throw error;
    } finally {
      event.set({
        status_code: statusCode,
        viewer_count: viewerCount,
        auth: request.headers.get("x-or-live-auth") === "ticket" ? "ticket" : "direct",
        ...(projectId === undefined ? {} : { project_id: projectId }),
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
      });
      event.emit(outcome);
    }
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const socketContext = readLiveSocketContext(ws);
    const event = startWideEvent("worker", "do.live_message", socketContext.requestId ?? uuidv7());
    let outcome: WideEventOutcome = "success";
    const messageKind =
      message === "ping" ? "ping" : typeof message === "string" ? "text" : "binary";

    try {
      if (message === "ping") {
        ws.send("pong");
      }
    } catch (error) {
      outcome = "server_error";
      event.fail(error);
      throw error;
    } finally {
      event.set({
        ...liveSocketEventFields(socketContext),
        message_kind: messageKind,
        viewer_count: this.ctx.getWebSockets("viewer").length,
      });
      event.emit(outcome);
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    const socketContext = readLiveSocketContext(ws);
    const event = startWideEvent(
      "worker",
      "do.live_disconnect",
      socketContext.requestId ?? uuidv7(),
    );

    try {
      // The close callback has no cleanup work; it exists to emit the event in finally.
    } finally {
      event.set({
        ...liveSocketEventFields(socketContext),
        close_code: code,
        close_reason: safeLogText(reason),
        was_clean: wasClean,
        viewer_count: this.ctx.getWebSockets("viewer").length,
      });
      event.emit("success");
    }
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    const socketContext = readLiveSocketContext(ws);
    const event = startWideEvent("worker", "do.live_error", socketContext.requestId ?? uuidv7());

    try {
      event.fail(error);
    } finally {
      event.set({
        ...liveSocketEventFields(socketContext),
        viewer_count: this.ctx.getWebSockets("viewer").length,
      });
      event.emit("server_error");
    }
  }

  private createSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id=1),
        v TEXT
      );
      CREATE TABLE IF NOT EXISTS batches (
        tab TEXT,
        seq INTEGER,
        t0 INTEGER,
        t1 INTEGER,
        bytes INTEGER,
        flags INTEGER,
        events TEXT,
        body BLOB,
        PRIMARY KEY (tab, seq)
      );
      CREATE TABLE IF NOT EXISTS segments (
        n INTEGER PRIMARY KEY,
        key TEXT,
        bytes INTEGER,
        t0 INTEGER,
        t1 INTEGER,
        batches INTEGER,
        events TEXT
      );
      CREATE TABLE IF NOT EXISTS segment_intents (
        n INTEGER PRIMARY KEY,
        key TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        t0 INTEGER NOT NULL,
        t1 INTEGER NOT NULL,
        batches INTEGER NOT NULL,
        events TEXT NOT NULL,
        rows_json TEXT NOT NULL,
        body BLOB NOT NULL,
        batch_bytes INTEGER NOT NULL
      );
    `);
  }

  private requestCheckpointOnNextAppend(): void {
    const state = this.sessionState;
    if (state === null || state.checkpointRequested === true) {
      return;
    }

    state.checkpointRequested = true;
    this.sessionState = state;
    this.persistState(state);
  }

  private loadStoredState(): {
    state: SessionState | null;
    tombstone: FinalizedTombstone | null;
  } {
    const row = this.ctx.storage.sql
      .exec<StateRow>("SELECT v FROM state WHERE id = 1")
      .toArray()[0];
    if (row === undefined) {
      return { state: null, tombstone: null };
    }

    const parsed = JSON.parse(row.v) as unknown;
    if (isFinalizedTombstone(parsed)) {
      return { state: null, tombstone: normalizeFinalizedTombstone(parsed) };
    }

    return { state: normalizeSessionState(parsed as SessionState), tombstone: null };
  }

  private persistState(state: SessionState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO state (id, v)
        VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET v = excluded.v`,
      JSON.stringify(state),
    );
  }

  private pendingBatchCount(): number {
    return this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM batches WHERE body IS NOT NULL")
      .one().count;
  }

  private pendingBatchBytes(): number {
    return this.ctx.storage.sql
      .exec<CountRow>("SELECT COALESCE(SUM(bytes), 0) AS count FROM batches WHERE body IS NOT NULL")
      .one().count;
  }

  private batchExists(tab: string, seq: number): boolean {
    return (
      this.ctx.storage.sql
        .exec<CountRow>("SELECT COUNT(*) AS count FROM batches WHERE tab = ? AND seq = ?", tab, seq)
        .one().count > 0
    );
  }

  private pendingBatchRows(): BatchRow[] {
    return this.ctx.storage.sql
      .exec<BatchRow>(
        `SELECT tab, seq, t0, t1, bytes, flags, events, body
          FROM batches
          WHERE body IS NOT NULL
          ORDER BY t0, tab, seq`,
      )
      .toArray();
  }

  private segmentRows(): SegmentRow[] {
    return this.ctx.storage.sql
      .exec<SegmentRow>("SELECT n, key, bytes, t0, t1, batches, events FROM segments ORDER BY n")
      .toArray();
  }

  private maxSegmentNumber(): number {
    const row = this.ctx.storage.sql
      .exec<CountRow>("SELECT COALESCE(MAX(n), 0) AS count FROM segments")
      .toArray()[0];
    return row?.count ?? 0;
  }

  private pendingSegmentIntent(): SegmentIntent | null {
    const row = this.ctx.storage.sql
      .exec<SegmentIntentRow>(
        `SELECT n, key, bytes, t0, t1, batches, events, rows_json, body, batch_bytes
          FROM segment_intents
          ORDER BY n
          LIMIT 1`,
      )
      .toArray()[0];
    if (row === undefined) {
      return null;
    }

    return {
      n: row.n,
      key: row.key,
      bytes: row.bytes,
      t0: row.t0,
      t1: row.t1,
      batches: row.batches,
      events: row.events,
      rows: parseSegmentIntentRows(row.rows_json),
      body: new Uint8Array(row.body),
      batchBytes: row.batch_bytes,
    };
  }

  private segmentRefs(): SegmentRef[] {
    return this.segmentRows().map((row) => ({
      key: row.key,
      bytes: row.bytes,
      t0: row.t0,
      t1: row.t1,
      batches: row.batches,
    }));
  }

  private broadcastBatch(args: AppendArgs): number {
    const sockets = this.ctx.getWebSockets("viewer");
    const frame = encodeIngestBody(args.index, args.payload);

    for (const socket of sockets) {
      try {
        socket.send(frame);
      } catch {
        // A dead viewer must not block ingest.
      }
    }

    return sockets.length;
  }

  private async recordingExists(projectId: string, sessionId: string): Promise<boolean> {
    const manifest = await this.env.RECORDINGS.head(manifestKey(projectId, sessionId));
    if (manifest !== null) {
      return true;
    }

    return (await this.env.RECORDINGS.head(segmentKey(projectId, sessionId, 1))) !== null;
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

  private async assertRecordingMatches(key: string, expected: Uint8Array): Promise<void> {
    const existing = await this.env.RECORDINGS.get(key);
    if (existing === null) {
      throw new Error(`R2 create-only write was not confirmed: ${key}`);
    }
    const actual = new Uint8Array(await existing.arrayBuffer());
    if (!bytesEqual(actual, expected)) {
      throw new Error(`R2 create-only write does not match expected object: ${key}`);
    }
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

    const recoveredSegmentCount = this.maxSegmentNumber();
    if (recoveredSegmentCount > state.segmentCount) {
      state.segmentCount = recoveredSegmentCount;
      this.persistState(state);
    }

    let totalSegmentBytes = 0;
    let totalBatches = 0;
    const pendingIntent = this.pendingSegmentIntent();
    if (pendingIntent !== null) {
      await this.completeSegmentIntent(state, pendingIntent);
      totalSegmentBytes += pendingIntent.bytes;
      totalBatches += pendingIntent.batches;
    }

    const rows = this.pendingBatchRows();
    if (rows.length === 0) {
      return totalBatches === 0
        ? null
        : { reason, bytes: totalSegmentBytes, batches: totalBatches };
    }

    const emptyRows = rows.filter((row) => row.bytes === 0 || row.body.byteLength === 0);
    const segmentRows = rows.filter((row) => row.bytes > 0 && row.body.byteLength > 0);

    for (const row of emptyRows) {
      this.ctx.storage.sql.exec(
        "UPDATE batches SET body = NULL WHERE tab = ? AND seq = ? AND body IS NOT NULL",
        row.tab,
        row.seq,
      );
    }

    if (emptyRows.length > 0) {
      state.bufferedBytes = this.pendingBatchBytes();
      state.lastFlushAt = Date.now();
      this.persistState(state);
    }

    if (segmentRows.length === 0) {
      return totalBatches === 0
        ? null
        : { reason, bytes: totalSegmentBytes, batches: totalBatches };
    }

    for (const chunk of chunkForSegments(segmentRows)) {
      if (state.segmentCount >= MAX_MANIFEST_SEGMENTS) {
        for (const row of chunk) {
          this.ctx.storage.sql.exec(
            "UPDATE batches SET body = NULL WHERE tab = ? AND seq = ? AND body IS NOT NULL",
            row.tab,
            row.seq,
          );
        }
        state.bufferedBytes = this.pendingBatchBytes();
        state.lastFlushAt = Date.now();
        this.persistState(state);
        continue;
      }

      const bodies = chunk.map((row) =>
        encodeIngestBody(batchIndexForSegmentRow(state.sessionId, row), new Uint8Array(row.body)),
      );
      const bodyBytes = chunk.reduce((total, row) => total + row.bytes, 0);
      const segment = buildSegment(bodies);
      const events = capTimelineEventsToBudget(
        chunk.flatMap((row) => parseEvents(row.events)).toSorted((left, right) => left.t - right.t),
        MAX_MANIFEST_TIMELINE_EVENTS,
      );
      const nextSegmentNumber = state.segmentCount + 1;
      const key = segmentKey(state.projectId, state.sessionId, nextSegmentNumber);
      const t0 = Math.min(...chunk.map((row) => row.t0));
      const t1 = Math.max(...chunk.map((row) => row.t1));
      const intent: SegmentIntent = {
        n: nextSegmentNumber,
        key,
        bytes: segment.byteLength,
        t0,
        t1,
        batches: chunk.length,
        events: JSON.stringify(events),
        rows: chunk.map((row) => ({ tab: row.tab, seq: row.seq })),
        body: segment,
        batchBytes: bodyBytes,
      };

      this.persistSegmentIntent(intent);
      await this.completeSegmentIntent(state, intent);
      totalSegmentBytes += intent.bytes;
      totalBatches += intent.batches;
    }

    return { reason, bytes: totalSegmentBytes, batches: totalBatches };
  }

  private persistSegmentIntent(intent: SegmentIntent): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO segment_intents
        (n, key, bytes, t0, t1, batches, events, rows_json, body, batch_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      intent.n,
      intent.key,
      intent.bytes,
      intent.t0,
      intent.t1,
      intent.batches,
      intent.events,
      JSON.stringify(intent.rows),
      exactArrayBuffer(intent.body),
      intent.batchBytes,
    );
  }

  private async completeSegmentIntent(state: SessionState, intent: SegmentIntent): Promise<void> {
    const written = await this.env.RECORDINGS.put(intent.key, intent.body, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (written === null) {
      await this.assertRecordingMatches(intent.key, intent.body);
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO segments (n, key, bytes, t0, t1, batches, events)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(n) DO UPDATE SET
          key = excluded.key,
          bytes = excluded.bytes,
          t0 = excluded.t0,
          t1 = excluded.t1,
          batches = excluded.batches,
          events = excluded.events`,
      intent.n,
      intent.key,
      intent.bytes,
      intent.t0,
      intent.t1,
      intent.batches,
      intent.events,
    );

    for (const row of intent.rows) {
      this.ctx.storage.sql.exec(
        "UPDATE batches SET body = NULL WHERE tab = ? AND seq = ? AND body IS NOT NULL",
        row.tab,
        row.seq,
      );
    }

    state.bufferedBytes = this.pendingBatchBytes();
    state.segmentCount = Math.max(state.segmentCount, intent.n);
    state.lastFlushAt = Date.now();
    this.persistState(state);
    this.ctx.storage.sql.exec("DELETE FROM segment_intents WHERE n = ?", intent.n);
  }

  private async setAlarmIfUseful(desiredAt: number, flushTailMs: number): Promise<void> {
    const now = Date.now();
    if (shouldSetAlarm({ alarmAt: this.alarmAt, now, desiredAt, flushTailMs })) {
      await this.ctx.storage.setAlarm(desiredAt);
      this.alarmAt = desiredAt;
    }
  }

  private async finalize(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.finalizeLocked();
    });
  }

  private async finalizeLocked(): Promise<void> {
    const stateBeforeFlush = this.sessionState;
    const event = startWideEvent("worker", "do.finalize", stateBeforeFlush?.firstRequestId);
    let segmentCount = 0;
    let bytes = 0;
    let batchCount = 0;
    let timelineEventsDropped = 0;
    let presenceRemoveError: string | undefined;

    try {
      if (stateBeforeFlush === null) {
        return;
      }

      await this.flushSegment("finalize");
      const state = this.sessionState;
      if (state === null) {
        return;
      }

      const segmentsForManifest = this.segmentRowsForManifest();
      const manifest = buildSessionManifest(state, segmentsForManifest);
      segmentCount = manifest.segments.length;
      bytes = manifest.bytes;
      batchCount = manifest.counts.batches;
      timelineEventsDropped = Math.max(
        0,
        countTimelineEvents(segmentsForManifest) - manifest.timeline.length,
      );
      const key = manifestKey(state.projectId, state.sessionId);

      const message = capFinalizeMessageToBudget({
        type: "session.finalized",
        sessionId: state.sessionId,
        projectId: state.projectId,
        orgId: state.orgId,
        shard: state.shard,
        requestId: state.firstRequestId,
        manifestKey: key,
        startedAt: manifest.startedAt,
        endedAt: manifest.endedAt,
        bytes: manifest.bytes,
        segments: manifest.segments.length,
        flags: manifest.flags,
        counts: manifest.counts,
        attrs: manifest.attrs,
        retentionDays: state.retentionDays,
        events: filterFinalizeEvents(manifest.timeline),
      } satisfies FinalizeMessage);
      sessionManifestSchema.parse(manifest);
      finalizeMessageSchema.parse(message);

      const manifestWritten = await this.env.RECORDINGS.put(key, JSON.stringify(manifest), {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (manifestWritten === null) {
        await this.assertRecordingMatches(key, utf8Encoder.encode(JSON.stringify(manifest)));
      }

      await this.env.FINALIZE_QUEUE.send(message, { contentType: "json" });
      presenceRemoveError = this.queuePresenceRemove(
        state.projectId,
        state.sessionId,
        state.firstRequestId,
      );

      for (const socket of this.ctx.getWebSockets("viewer")) {
        try {
          socket.close(1000);
        } catch {
          // Closing a dead viewer is best effort.
        }
      }

      const finalizedAt = Date.now();
      const purgeAt = finalizedAt + state.retentionDays * 86_400_000;
      const tombstone: FinalizedTombstone = {
        finalized: true,
        finalizedAt,
        purgeAt,
        firstRequestId: state.firstRequestId,
        projectId: state.projectId,
        orgId: state.orgId,
        sessionId: state.sessionId,
      };
      this.ctx.storage.sql.exec("DELETE FROM batches");
      this.ctx.storage.sql.exec("DELETE FROM segments");
      this.ctx.storage.sql.exec("DELETE FROM segment_intents");
      this.ctx.storage.sql.exec("DELETE FROM state");
      this.ctx.storage.sql.exec(
        "INSERT INTO state (id, v) VALUES (1, ?)",
        JSON.stringify(tombstone),
      );
      this.sessionState = null;
      this.finalizedTombstone = tombstone;
      await this.ctx.storage.setAlarm(purgeAt);
      this.alarmAt = purgeAt;
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
        segments: segmentCount,
        bytes,
        batch_count: batchCount,
        timeline_events_dropped: timelineEventsDropped,
      });
      if (presenceRemoveError !== undefined) {
        event.set({ presence_remove_error: presenceRemoveError });
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
      const task = sendPresenceSessionRequest(this.env, "/ping", requestId, {
        projectId: state.projectId,
        sessionId: state.sessionId,
        startedAt: state.startedAt,
        lastSeen,
        entryUrl: state.entryUrl ?? null,
        country: state.attrs.country ?? null,
        city: state.attrs.city ?? null,
        browser: state.attrs.browser ?? null,
        os: state.attrs.os ?? null,
        device: state.attrs.device ?? null,
      }).catch(() => undefined);
      this.ctx.waitUntil(task);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  private queuePresenceRemove(
    projectId: string,
    sessionId: string,
    requestId: string,
  ): string | undefined {
    try {
      this.throwIfPresenceFailsForTest();
      const task = sendPresenceSessionRequest(this.env, "/remove", requestId, {
        projectId,
        sessionId,
      }).catch(() => undefined);
      this.ctx.waitUntil(task);
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

  private segmentRowsForManifest(): SegmentForManifest[] {
    return this.segmentRows().map((row) => ({
      key: row.key,
      bytes: row.bytes,
      t0: row.t0,
      t1: row.t1,
      batches: row.batches,
      events: parseEvents(row.events),
    }));
  }
}

function createFreshState(args: AppendArgs): SessionState {
  return {
    projectId: args.projectId,
    orgId: args.orgId,
    shard: args.shard,
    retentionDays: args.retentionDays,
    sessionId: args.sessionId,
    startedAt: args.receivedAt,
    lastActivity: args.receivedAt,
    lastFlushAt: args.receivedAt,
    bufferedBytes: 0,
    totalPayloadBytes: 0,
    totalEventBytes: 0,
    batchCount: 0,
    segmentCount: 0,
    flags: 0,
    attrs: args.attrs,
    firstRequestId: args.requestId,
    urlCount: 0,
  };
}

function normalizeSessionState(state: SessionState): SessionState {
  return {
    ...state,
    totalEventBytes:
      typeof state.totalEventBytes === "number" && Number.isFinite(state.totalEventBytes)
        ? state.totalEventBytes
        : 0,
  };
}

function updateStateWithBatch(
  state: SessionState,
  args: AppendArgs,
  clampedIndex: AppendArgs["index"],
  eventBytes: number,
): void {
  state.lastActivity = args.receivedAt;
  state.bufferedBytes += args.payload.byteLength;
  state.totalPayloadBytes += args.payload.byteLength;
  state.totalEventBytes += eventBytes;
  state.batchCount += 1;
  state.flags = (state.flags | args.flags) >>> 0;

  if (clampedIndex.u !== undefined && clampedIndex.u.length > 0) {
    state.entryUrl ??= clampedIndex.u;
    state.urlCount += 1;
  }

  if (clampedIndex.enc?.k !== undefined) {
    state.encKeyId = clampedIndex.enc.k;
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function encodedBytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function parseEvents(raw: string): IndexEvent[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as IndexEvent[]) : [];
}

function parseSegmentIntentRows(raw: string): SegmentIntentBatchRef[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("segment intent rows are invalid");
  }

  return parsed.map((value) => {
    if (!isSegmentIntentBatchRef(value)) {
      throw new Error("segment intent rows are invalid");
    }

    return { tab: value.tab, seq: value.seq };
  });
}

function isSegmentIntentBatchRef(value: unknown): value is SegmentIntentBatchRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record["tab"] === "string" &&
    record["tab"].length > 0 &&
    Number.isSafeInteger(record["seq"]) &&
    typeof record["seq"] === "number" &&
    record["seq"] >= 0
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function batchIndexForSegmentRow(sessionId: string, row: BatchRow): AppendArgs["index"] {
  return {
    v: 1,
    s: sessionId,
    tab: row.tab,
    seq: row.seq,
    t0: row.t0,
    t1: row.t1,
    e: parseEvents(row.events),
  };
}

function isFinalizedTombstone(value: unknown): value is FinalizedTombstone {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate["finalized"] === true &&
    typeof candidate["finalizedAt"] === "number" &&
    Number.isFinite(candidate["finalizedAt"]) &&
    typeof candidate["firstRequestId"] === "string"
  );
}

function normalizeFinalizedTombstone(value: FinalizedTombstone): FinalizedTombstone {
  if (typeof value.purgeAt === "number" && Number.isFinite(value.purgeAt)) {
    return value;
  }

  return {
    ...value,
    purgeAt: value.finalizedAt + 86_400_000,
  };
}

function testIndex(sessionId: string, tab: string, seq: number, t0: number): AppendArgs["index"] {
  return {
    v: 1,
    s: sessionId,
    tab,
    seq,
    t0,
    t1: t0 + 1,
    u: `/seed-${seq}`,
    e: [{ t: t0, k: "custom", d: `seed-${seq}` }],
  };
}

function livePathIds(pathname: string): { projectId: string; sessionId: string } | null {
  const match = /^\/api\/v1\/projects\/([^/]+)\/sessions\/([^/]+)\/live$/.exec(pathname);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }

  return {
    projectId: match[1],
    sessionId: match[2],
  };
}

function makeTestPayload(size: number, seq: number): Uint8Array {
  const payload = new Uint8Array(Math.max(0, size));
  payload.fill((seq % 251) + 1);
  return payload;
}

function errorMessage(error: unknown): string {
  return safeLogText(error instanceof Error ? error.message : String(error));
}

function readLiveSocketContext(ws: WebSocket): LiveSocketContext {
  const value = ws.deserializeAttachment();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    requestId: readOptionalId(record["requestId"]),
    projectId: readOptionalId(record["projectId"]),
    sessionId: readOptionalId(record["sessionId"]),
  };
}

function liveSocketEventFields(context: LiveSocketContext): Record<string, string> {
  return {
    ...(context.projectId === undefined ? {} : { project_id: context.projectId }),
    ...(context.sessionId === undefined ? {} : { session_id: context.sessionId }),
  };
}

function readOptionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeLogText(value: string): string {
  return value.length <= 200 ? value : value.slice(0, 200);
}
