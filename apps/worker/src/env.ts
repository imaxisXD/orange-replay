// Binding surface for the combined Worker. Owned by the Phase 0 seed —
// tasks extend behavior in their own modules, not here, unless their PLAN.md
// scope says otherwise.
import type { FinalizeMessage } from "@orange-replay/shared";
import type { SessionRecorder } from "./do/session-recorder.ts";

export type { FinalizeMessage };

export interface Env {
  SESSION: DurableObjectNamespace<SessionRecorder>;
  RECORDINGS: R2Bucket;
  CONFIG: KVNamespace;
  IDX_00: D1Database;
  FINALIZE_QUEUE: Queue<FinalizeMessage>;
  TRENDS?: AnalyticsEngineDataset;
  /** Bearer token for dashboard API auth (v1). Set via .dev.vars / secret. */
  DEV_API_TOKEN?: string;
  /** "1" enables /__test/* routes. Never set in production config. */
  DEV_TEST_ROUTES?: string;
}

/**
 * Hosted plane maps org shard -> IDX_xx binding; self-host runs one shard.
 */
export function shardDb(env: Env, _shard: number): D1Database {
  return env.IDX_00;
}
