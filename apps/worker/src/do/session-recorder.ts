// SessionRecorder Durable Object — placeholder until T1.2 implements it.
// Invariants when implementing (see ARCHITECTURE.md + PLAN.md): hibernation
// WebSockets only, minimal setAlarm writes, (tab, seq) idempotency, payload
// bytes are never decompressed here.
import { DurableObject } from "cloudflare:workers";

export class SessionRecorder extends DurableObject {
  async ping(): Promise<string> {
    return "pong";
  }
}
