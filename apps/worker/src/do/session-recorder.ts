import {
  buildSegment,
  encodeIngestBody,
  HDR_REQUEST_ID,
  manifestKey,
  segmentKey,
  startWideEvent,
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
import type { AppendArgs, AppendResult } from "./contract.ts";
import { resolvePresenceTiming, shouldSendPresencePing } from "./presence-logic.ts";
import {
  buildSessionManifest,
  capFinalizeMessageToBudget,
  chunkForSegments,
  clampIndexForStorage,
  countTimelineEvents,
  decideSegmentFlush,
  filterFinalizeEvents,
  nextAlarmAfterAlarm,
  resolveSessionTiming,
  shouldDropForSessionCap,
  shouldSetAlarm,
  sdkFlushMs,
} from "./session-logic.ts";
import type { SegmentFlushReason, SegmentForManifest, SessionState } from "./session-logic.ts";

type SqlRowValue = ArrayBuffer | string | number | null;

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

interface DebugState {
  hasState: boolean;
  finalized: boolean;
  bufferedBytes: number;
  pendingBatches: number;
  segmentCount: number;
  stateBytes: number;
  tombstonePurgeAt?: number;
}

interface SegmentFlushResult {
  reason: SegmentFlushReason;
  bytes: number;
  batches: number;
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
  firstRequestId: string;
}

export class SessionRecorder extends DurableObject<Env> {
  private sessionState: SessionState | null = null;
  private finalizedTombstone: FinalizedTombstone | null = null;
  private alarmAt: number | null = null;
  private activeFlush: Promise<SegmentFlushResult | null> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
    const timing = resolveSessionTiming(this.env.DEV_TEST_ROUTES, this.env.TEST_TIMINGS);
    let result: AppendResult = { live: false, closed: false, flushMs: sdkFlushMs(false) };
    let outcome: WideEventOutcome = "success";
    let dropReason: "session_closed" | "session_cap" | undefined;
    let duplicate = false;
    let flushReason: SegmentFlushReason | undefined;
    let viewerCount = 0;
    let bufferedBytes = this.sessionState?.bufferedBytes ?? 0;
    let presencePingError: string | undefined;

    try {
      let state = this.sessionState;
      if (this.finalizedTombstone !== null) {
        outcome = "dropped";
        dropReason = "session_closed";
        result = { live: false, closed: true, flushMs: sdkFlushMs(false) };
        return result;
      }

      if (state === null) {
        if (args.seq !== 0) {
          outcome = "dropped";
          dropReason = "session_closed";
          result = { live: false, closed: true, flushMs: sdkFlushMs(false) };
          return result;
        }

        state = createFreshState(args);
      }

      const clampedIndex = clampIndexForStorage(args.index, state.startedAt, args.receivedAt);
      duplicate = this.batchExists(args.tab, args.seq);
      viewerCount = this.ctx.getWebSockets("viewer").length;

      if (duplicate) {
        result = { live: viewerCount > 0, closed: false, flushMs: sdkFlushMs(viewerCount > 0) };
        return result;
      }

      if (
        shouldDropForSessionCap({
          totalPayloadBytes: state.totalPayloadBytes,
          batchCount: state.batchCount,
          payloadBytes: args.payload.byteLength,
        })
      ) {
        outcome = "dropped";
        dropReason = "session_cap";
        result = { live: viewerCount > 0, closed: false, flushMs: sdkFlushMs(viewerCount > 0) };
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
        JSON.stringify(clampedIndex.e),
        exactArrayBuffer(args.payload),
      );
      duplicate = insert.rowsWritten === 0;

      if (duplicate) {
        result = { live: viewerCount > 0, closed: false, flushMs: sdkFlushMs(viewerCount > 0) };
        return result;
      }

      updateStateWithBatch(state, args, clampedIndex);

      const presenceTiming = resolvePresenceTiming(this.env.DEV_TEST_ROUTES, this.env.TEST_TIMINGS);
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
      result = { live: viewerCount > 0, closed: false, flushMs: sdkFlushMs(viewerCount > 0) };
      return result;
    } catch (err) {
      outcome = "server_error";
      event.fail(err);
      throw err;
    } finally {
      event.set({
        project_id: args.projectId,
        session_id: args.sessionId,
        tab: args.tab,
        seq: args.seq,
        bytes_in: args.payload.byteLength,
        buffered_bytes: bufferedBytes,
        viewer_count: viewerCount,
        duplicate,
      });
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
    const timing = resolveSessionTiming(this.env.DEV_TEST_ROUTES, this.env.TEST_TIMINGS);
    const stateBytes = this.stateBytes();
    return {
      hasState: this.sessionState !== null,
      finalized: this.finalizedTombstone !== null,
      bufferedBytes: this.sessionState?.bufferedBytes ?? 0,
      pendingBatches: this.pendingBatchCount(),
      segmentCount: this.sessionState?.segmentCount ?? this.segmentRows().length,
      stateBytes,
      ...(this.finalizedTombstone === null
        ? {}
        : { tombstonePurgeAt: this.finalizedTombstone.finalizedAt + timing.closeMs * 4 }),
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
        JSON.stringify(index.e),
        exactArrayBuffer(payload),
      );

      updateStateWithBatch(state, { ...args, seq, index, payload }, index);
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
    const timing = resolveSessionTiming(this.env.DEV_TEST_ROUTES, this.env.TEST_TIMINGS);
    let alarmKind: "tail_flush" | "close" | "purge_tombstone" | "noop" = "noop";

    try {
      this.alarmAt = null;
      if (this.finalizedTombstone !== null) {
        const purgeAt = this.finalizedTombstone.finalizedAt + timing.closeMs * 4;
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
      event.set({ alarm_kind: alarmKind });
      event.emit();
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const wantsLiveSocket =
      url.pathname.endsWith("/live") &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket";

    if (!wantsLiveSocket || this.sessionState === null) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["viewer"]);
    server.send(
      JSON.stringify({
        type: "hello",
        sessionId: this.sessionState.sessionId,
        startedAt: this.sessionState.startedAt,
        segments: this.segmentRefs(),
        pendingBatches: this.pendingBatchCount(),
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") {
      ws.send("pong");
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
    `);
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
      return { state: null, tombstone: parsed };
    }

    return { state: parsed as SessionState, tombstone: null };
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

    const rows = this.pendingBatchRows();
    if (rows.length === 0) {
      return null;
    }

    const emptyRows = rows.filter((row) => row.bytes === 0 || row.body.byteLength === 0);
    const segmentRows = rows.filter((row) => row.bytes > 0 && row.body.byteLength > 0);
    const emptyBytes = emptyRows.reduce((total, row) => total + row.bytes, 0);

    for (const row of emptyRows) {
      this.ctx.storage.sql.exec(
        "UPDATE batches SET body = NULL WHERE tab = ? AND seq = ? AND body IS NOT NULL",
        row.tab,
        row.seq,
      );
    }

    if (segmentRows.length === 0) {
      state.bufferedBytes = Math.max(0, state.bufferedBytes - emptyBytes);
      state.lastFlushAt = Date.now();
      this.persistState(state);
      return null;
    }

    let totalSegmentBytes = 0;
    let totalBatches = 0;
    let flushedBodyBytes = emptyBytes;

    for (const chunk of chunkForSegments(segmentRows)) {
      const bodies = chunk.map((row) => new Uint8Array(row.body));
      const bodyBytes = chunk.reduce((total, row) => total + row.bytes, 0);
      const segment = buildSegment(bodies);
      const events = chunk
        .flatMap((row) => parseEvents(row.events))
        .toSorted((left, right) => left.t - right.t);
      const nextSegmentNumber = state.segmentCount + 1;
      const key = segmentKey(state.projectId, state.sessionId, nextSegmentNumber);
      const t0 = Math.min(...chunk.map((row) => row.t0));
      const t1 = Math.max(...chunk.map((row) => row.t1));

      const written = await this.env.RECORDINGS.put(key, segment, {
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (written === null) {
        throw new Error(`R2 object already exists: ${key}`);
      }

      this.ctx.storage.sql.exec(
        "INSERT INTO segments (n, key, bytes, t0, t1, batches, events) VALUES (?, ?, ?, ?, ?, ?, ?)",
        nextSegmentNumber,
        key,
        segment.byteLength,
        t0,
        t1,
        chunk.length,
        JSON.stringify(events),
      );

      for (const row of chunk) {
        this.ctx.storage.sql.exec(
          "UPDATE batches SET body = NULL WHERE tab = ? AND seq = ? AND body IS NOT NULL",
          row.tab,
          row.seq,
        );
      }

      flushedBodyBytes += bodyBytes;
      totalSegmentBytes += segment.byteLength;
      totalBatches += chunk.length;
      state.bufferedBytes = Math.max(0, state.bufferedBytes - flushedBodyBytes);
      state.segmentCount = nextSegmentNumber;
      state.lastFlushAt = Date.now();
      this.persistState(state);
      flushedBodyBytes = 0;
    }

    return { reason, bytes: totalSegmentBytes, batches: totalBatches };
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

      const manifestWritten = await this.env.RECORDINGS.put(key, JSON.stringify(manifest), {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (manifestWritten === null) {
        throw new Error(`R2 object already exists: ${key}`);
      }

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
      const tombstone: FinalizedTombstone = {
        finalized: true,
        finalizedAt,
        firstRequestId: state.firstRequestId,
      };
      this.ctx.storage.sql.exec("DELETE FROM batches");
      this.ctx.storage.sql.exec("DELETE FROM segments");
      this.ctx.storage.sql.exec("DELETE FROM state");
      this.ctx.storage.sql.exec(
        "INSERT INTO state (id, v) VALUES (1, ?)",
        JSON.stringify(tombstone),
      );
      this.sessionState = null;
      this.finalizedTombstone = tombstone;
      const timing = resolveSessionTiming(this.env.DEV_TEST_ROUTES, this.env.TEST_TIMINGS);
      await this.ctx.storage.setAlarm(finalizedAt + timing.closeMs * 4);
      this.alarmAt = finalizedAt + timing.closeMs * 4;
    } catch (err) {
      event.fail(err);
      throw err;
    } finally {
      event.set({
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
      const task = this.fetchPresence("/ping", requestId, {
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
      const task = this.fetchPresence("/remove", requestId, {
        projectId,
        sessionId,
      }).catch(() => undefined);
      this.ctx.waitUntil(task);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  private async fetchPresence(path: "/ping" | "/remove", requestId: string, body: unknown) {
    const projectId = (body as { projectId?: string }).projectId;
    if (projectId === undefined) {
      throw new Error("projectId is required");
    }

    const stub = this.env.PRESENCE.get(this.env.PRESENCE.idFromName(projectId));
    const response = await stub.fetch(`https://presence.internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HDR_REQUEST_ID]: requestId,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`presence registry returned ${response.status}`);
    }
  }

  private throwIfPresenceFailsForTest(): void {
    const timing = resolvePresenceTiming(this.env.DEV_TEST_ROUTES, this.env.TEST_TIMINGS);
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
    batchCount: 0,
    segmentCount: 0,
    flags: 0,
    attrs: args.attrs,
    firstRequestId: args.requestId,
    urlCount: 0,
  };
}

function updateStateWithBatch(
  state: SessionState,
  args: AppendArgs,
  clampedIndex: AppendArgs["index"],
): void {
  state.lastActivity = args.receivedAt;
  state.bufferedBytes += args.payload.byteLength;
  state.totalPayloadBytes += args.payload.byteLength;
  state.batchCount += 1;
  state.flags |= args.flags;

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

function parseEvents(raw: string): IndexEvent[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as IndexEvent[]) : [];
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

function makeTestPayload(size: number, seq: number): Uint8Array {
  const payload = new Uint8Array(Math.max(0, size));
  payload.fill((seq % 251) + 1);
  return payload;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
