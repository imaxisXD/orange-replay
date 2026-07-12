import {
  encodeIngestBody,
  HDR_REQUEST_ID,
  MAX_LIVE_VIEWERS_PER_SESSION,
  startWideEvent,
  uuidv7,
} from "@orange-replay/shared";
import type { LiveSessionSnapshot, SegmentRef, WideEventOutcome } from "@orange-replay/shared";
import type { AppendArgs } from "./contract.ts";
import type { SessionState } from "./session-logic.ts";

export interface SessionLiveHubDependencies {
  ctx: DurableObjectState;
  getSessionState: () => SessionState | null;
  getSegmentRefs: () => SegmentRef[];
  getPendingBatchCount: () => number;
  getLiveSnapshot: () => LiveSessionSnapshot | null;
  requestCheckpointOnNextAppend: () => void;
}

interface LiveSocketContext {
  requestId?: string;
  projectId?: string;
  sessionId?: string;
}

export class SessionLiveHub {
  constructor(private readonly dependencies: SessionLiveHubDependencies) {}

  viewerCount(): number {
    return this.dependencies.ctx.getWebSockets("viewer").length;
  }

  broadcastBatch(args: AppendArgs): number {
    const sockets = this.dependencies.ctx.getWebSockets("viewer");
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

  closeViewers(): void {
    for (const socket of this.dependencies.ctx.getWebSockets("viewer")) {
      try {
        socket.close(1000);
      } catch {
        // Closing a dead viewer is best effort.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get(HDR_REQUEST_ID) ?? uuidv7();
    const event = startWideEvent("worker", "do.live_connect", requestId);
    const wantsLiveSocket =
      url.pathname.endsWith("/live") &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket";
    let statusCode = 500;
    let outcome: WideEventOutcome = "server_error";
    let viewerCount = this.viewerCount();
    const pathIds = livePathIds(url.pathname);
    const state = this.dependencies.getSessionState();
    let projectId = state?.projectId ?? pathIds?.projectId;
    let sessionId = state?.sessionId ?? pathIds?.sessionId;

    try {
      if (!wantsLiveSocket || state === null) {
        const response = Response.json({ error: "not_found" }, { status: 404 });
        statusCode = response.status;
        outcome = "client_error";
        return response;
      }

      projectId = state.projectId;
      sessionId = state.sessionId;
      if (viewerCount >= MAX_LIVE_VIEWERS_PER_SESSION) {
        const response = Response.json({ error: "viewer_limit" }, { status: 429 });
        statusCode = response.status;
        outcome = "rate_limited";
        return response;
      }
      const snapshot = this.dependencies.getLiveSnapshot();
      if (snapshot === null) {
        const response = Response.json({ error: "not_found" }, { status: 404 });
        statusCode = response.status;
        outcome = "client_error";
        return response;
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.dependencies.ctx.acceptWebSocket(server, ["viewer"]);
      server.serializeAttachment({
        requestId,
        projectId,
        sessionId,
      } satisfies LiveSocketContext);
      this.dependencies.requestCheckpointOnNextAppend();
      viewerCount = this.viewerCount();
      server.send(
        JSON.stringify({
          type: "hello",
          sessionId: state.sessionId,
          startedAt: state.startedAt,
          segments: this.dependencies.getSegmentRefs(),
          pendingBatches: this.dependencies.getPendingBatchCount(),
          snapshot,
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

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
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
        viewer_count: this.viewerCount(),
      });
      event.emit(outcome);
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
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
        viewer_count: this.viewerCount(),
      });
      event.emit("success");
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    const socketContext = readLiveSocketContext(ws);
    const event = startWideEvent("worker", "do.live_error", socketContext.requestId ?? uuidv7());

    try {
      event.fail(error);
    } finally {
      event.set({
        ...liveSocketEventFields(socketContext),
        viewer_count: this.viewerCount(),
      });
      event.emit("server_error");
    }
  }
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
