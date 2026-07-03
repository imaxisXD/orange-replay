// SessionRecorder Durable Object — contract stub until T1.2 implements it.
// Invariants for the implementation (see ARCHITECTURE.md + PLAN.md):
// hibernation WebSockets only, minimal setAlarm writes, (tab, seq)
// idempotency, payload bytes are never decompressed here.
import { SDK_FLUSH_DEFAULT_MS } from "@orange-replay/shared";
import { DurableObject } from "cloudflare:workers";
import type { AppendArgs, AppendResult } from "./contract.ts";

export class SessionRecorder extends DurableObject {
  async ping(): Promise<string> {
    return "pong";
  }

  async appendBatch(_args: AppendArgs): Promise<AppendResult> {
    return { live: false, closed: false, flushMs: SDK_FLUSH_DEFAULT_MS };
  }

  override async fetch(_request: Request): Promise<Response> {
    return Response.json({ error: "not_implemented" }, { status: 501 });
  }
}
