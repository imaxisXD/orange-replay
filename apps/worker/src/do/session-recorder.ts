import {
  buildSegment,
  encodeIngestBody,
  manifestKey,
  segmentKey,
  startWideEvent,
} from "@orange-replay/shared";
import type { FinalizeMessage, IndexEvent, SegmentRef } from "@orange-replay/shared";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { AppendArgs, AppendResult } from "./contract.ts";
import {
  buildSessionManifest,
  decideSegmentFlush,
  filterFinalizeEvents,
  resolveSessionTiming,
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
  bufferedBytes: number;
  pendingBatches: number;
  segmentCount: number;
}

interface SegmentFlushResult {
  reason: SegmentFlushReason;
  bytes: number;
  batches: number;
}

export class SessionRecorder extends DurableObject<Env> {
  private sessionState: SessionState | null = null;
  private alarmAt: number | null = null;
  private activeFlush: Promise<SegmentFlushResult | null> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.createSchema();
    void ctx.blockConcurrencyWhile(async () => {
      this.sessionState = this.loadSessionState();
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
    let duplicate = false;
    let flushReason: SegmentFlushReason | undefined;
    let viewerCount = 0;
    let bufferedBytes = this.sessionState?.bufferedBytes ?? 0;

    try {
      let state = this.sessionState;
      if (state === null) {
        if (args.seq !== 0) {
          result = { live: false, closed: true, flushMs: sdkFlushMs(false) };
          return result;
        }

        state = createFreshState(args);
      }

      const insert = this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO batches
          (tab, seq, t0, t1, bytes, flags, events, body)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args.tab,
        args.seq,
        args.index.t0,
        args.index.t1,
        args.payload.byteLength,
        args.flags,
        JSON.stringify(args.index.e),
        exactArrayBuffer(args.payload),
      );
      duplicate = insert.rowsWritten === 0;
      viewerCount = this.ctx.getWebSockets("viewer").length;

      if (duplicate) {
        result = { live: viewerCount > 0, closed: false, flushMs: sdkFlushMs(viewerCount > 0) };
        return result;
      }

      updateStateWithBatch(state, args);
      this.sessionState = state;
      this.persistState(state);
      bufferedBytes = state.bufferedBytes;

      viewerCount = this.broadcastBatch(args);

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
      event.emit();
    }
  }

  async debug(): Promise<DebugState> {
    return {
      hasState: this.sessionState !== null,
      bufferedBytes: this.sessionState?.bufferedBytes ?? 0,
      pendingBatches: this.pendingBatchCount(),
      segmentCount: this.sessionState?.segmentCount ?? this.segmentRows().length,
    };
  }

  override async alarm(): Promise<void> {
    const event = startWideEvent("worker", "do.alarm", this.sessionState?.firstRequestId);
    const timing = resolveSessionTiming(this.env.DEV_TEST_ROUTES, this.env.TEST_TIMINGS);
    let alarmKind: "tail_flush" | "close" | "noop" = "noop";

    try {
      this.alarmAt = null;
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
        await this.setAlarmIfUseful(state.lastActivity + timing.closeMs, timing.flushTailMs);
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

  private loadSessionState(): SessionState | null {
    const row = this.ctx.storage.sql
      .exec<StateRow>("SELECT v FROM state WHERE id = 1")
      .toArray()[0];
    if (row === undefined) {
      return null;
    }

    return JSON.parse(row.v) as SessionState;
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

    const bodies = rows.map((row) => new Uint8Array(row.body));
    const bodyBytes = rows.reduce((total, row) => total + row.bytes, 0);
    const segment = buildSegment(bodies);
    const events = rows
      .flatMap((row) => parseEvents(row.events))
      .toSorted((left, right) => left.t - right.t);
    const nextSegmentNumber = state.segmentCount + 1;
    const key = segmentKey(state.projectId, state.sessionId, nextSegmentNumber);
    const t0 = Math.min(...rows.map((row) => row.t0));
    const t1 = Math.max(...rows.map((row) => row.t1));

    await this.env.RECORDINGS.put(key, segment);

    this.ctx.storage.sql.exec(
      "INSERT INTO segments (n, key, bytes, t0, t1, batches, events) VALUES (?, ?, ?, ?, ?, ?, ?)",
      nextSegmentNumber,
      key,
      segment.byteLength,
      t0,
      t1,
      rows.length,
      JSON.stringify(events),
    );

    for (const row of rows) {
      this.ctx.storage.sql.exec(
        "UPDATE batches SET body = NULL WHERE tab = ? AND seq = ? AND body IS NOT NULL",
        row.tab,
        row.seq,
      );
    }

    if (this.sessionState !== null) {
      this.sessionState.bufferedBytes = Math.max(0, this.sessionState.bufferedBytes - bodyBytes);
      this.sessionState.segmentCount = Math.max(this.sessionState.segmentCount, nextSegmentNumber);
      this.sessionState.lastFlushAt = Date.now();
      this.persistState(this.sessionState);
    }

    return { reason, bytes: segment.byteLength, batches: rows.length };
  }

  private async setAlarmIfUseful(desiredAt: number, flushTailMs: number): Promise<void> {
    const now = Date.now();
    if (
      this.alarmAt === null ||
      this.alarmAt <= now ||
      this.alarmAt > desiredAt + 2 * flushTailMs
    ) {
      await this.ctx.storage.setAlarm(desiredAt);
      this.alarmAt = desiredAt;
    }
  }

  private async finalize(): Promise<void> {
    const stateBeforeFlush = this.sessionState;
    const event = startWideEvent("worker", "do.finalize", stateBeforeFlush?.firstRequestId);
    let segmentCount = 0;
    let bytes = 0;
    let batchCount = 0;

    try {
      if (stateBeforeFlush === null) {
        return;
      }

      await this.flushSegment("finalize");
      const state = this.sessionState;
      if (state === null) {
        return;
      }

      const manifest = buildSessionManifest(state, this.segmentRowsForManifest());
      segmentCount = manifest.segments.length;
      bytes = manifest.bytes;
      batchCount = manifest.counts.batches;
      const key = manifestKey(state.projectId, state.sessionId);

      await this.env.RECORDINGS.put(key, JSON.stringify(manifest), {
        httpMetadata: { contentType: "application/json" },
      });

      const message: FinalizeMessage = {
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
        counts: manifest.counts,
        attrs: manifest.attrs,
        retentionDays: state.retentionDays,
        events: filterFinalizeEvents(manifest.timeline),
      };

      await this.env.FINALIZE_QUEUE.send(message, { contentType: "json" });

      for (const socket of this.ctx.getWebSockets("viewer")) {
        try {
          socket.close(1000);
        } catch {
          // Closing a dead viewer is best effort.
        }
      }

      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.sessionState = null;
      this.alarmAt = null;
      this.createSchema();
    } catch (err) {
      event.fail(err);
      throw err;
    } finally {
      event.set({ segments: segmentCount, bytes, batch_count: batchCount });
      event.emit();
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
    urls: [],
    urlCount: 0,
  };
}

function updateStateWithBatch(state: SessionState, args: AppendArgs): void {
  state.lastActivity = args.receivedAt;
  state.bufferedBytes += args.payload.byteLength;
  state.totalPayloadBytes += args.payload.byteLength;
  state.batchCount += 1;
  state.flags |= args.flags;

  if (args.index.u !== undefined && args.index.u.length > 0) {
    state.entryUrl ??= args.index.u;
    if (!state.urls.includes(args.index.u)) {
      state.urls.push(args.index.u);
    }
    state.urlCount = state.urls.length;
  }

  if (args.index.enc?.k !== undefined) {
    state.encKeyId = args.index.enc.k;
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function parseEvents(raw: string): IndexEvent[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as IndexEvent[]) : [];
}
