import type { IngestAck } from "@orange-replay/shared";
import type { AppendResult } from "../do/contract.ts";

export function jsonResponse(body: unknown, status: number, headers: Headers): Response {
  return Response.json(body, { status, headers });
}

export function ingestAckForAppendResult(result: AppendResult): IngestAck {
  return {
    ok: true,
    live: result.live,
    closed: result.closed || undefined,
    flushMs: result.flushMs,
    checkpoint: result.checkpoint || undefined,
    drop: result.drop || undefined,
  };
}
