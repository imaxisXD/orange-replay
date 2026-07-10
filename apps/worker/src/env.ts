// Binding surface for the combined Worker. Owned by the Phase 0 seed —
// tasks extend behavior in their own modules, not here, unless their PLAN.md
// scope says otherwise.
import type { FinalizeMessage } from "@orange-replay/shared";
import { setWideEventVersion } from "@orange-replay/shared";
import type { PresenceRegistry } from "./do/presence-registry.ts";
import type { SessionRecorder } from "./do/session-recorder.ts";

export type { FinalizeMessage };

export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS?: Fetcher;
  SESSION: DurableObjectNamespace<SessionRecorder>;
  PRESENCE: DurableObjectNamespace<PresenceRegistry>;
  RECORDINGS: R2Bucket;
  CONFIG: KVNamespace;
  IDX_00: D1Database;
  FINALIZE_QUEUE: Queue<FinalizeMessage>;
  INGEST_LOOKUP_RATE_LIMITER?: RateLimitBinding;
  INGEST_PROJECT_RATE_LIMITER?: RateLimitBinding;
  INGEST_SESSION_RATE_LIMITER?: RateLimitBinding;
  DEMO_API_RATE_LIMITER?: RateLimitBinding;
  TRENDS?: AnalyticsEngineDataset;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** Deployment environment name. Production disables all dev-only test gates. */
  WORKER_ENV?: string;
  /** Bearer token for dashboard API auth (v1). Set via local .env / Worker secret. */
  DEV_API_TOKEN?: string;
  /** Comma-separated project ids that DEV_API_TOKEN may access. */
  DEV_API_PROJECT_IDS?: string;
  /** Server-only HMAC secret for live WebSocket tickets. */
  LIVE_TICKET_SECRET?: string;
  /** Public read-only demo project id. Demo is disabled unless this and DEMO_WRITE_KEY are set. */
  DEMO_PROJECT_ID?: string;
  /** Public SDK write key for the demo landing page recorder. */
  DEMO_WRITE_KEY?: string;
  /** "1" enables /__test/* routes. Never set in production config. */
  DEV_TEST_ROUTES?: string;
  /**
   * JSON override for DO timing thresholds, honored only when
   * DEV_TEST_ROUTES === "1": { segmentFlushMs?, segmentFlushBytes?,
   * flushTailMs?, closeMs?, presenceTtlMs?, presenceHeartbeatMs? }. Lets
   * integration tests shrink the 30-minute idle windows to seconds.
   */
  TEST_TIMINGS?: string;
}

/**
 * Hosted plane maps org shard -> IDX_xx binding; self-host runs one shard.
 */
export function shardDb(env: Env, _shard: number): D1Database {
  return env.IDX_00;
}

export function setWorkerLoggerVersion(env: Pick<Env, "CF_VERSION_METADATA">): void {
  setWideEventVersion(env.CF_VERSION_METADATA?.tag ?? env.CF_VERSION_METADATA?.id);
}

export function isDevTestMode(env: Pick<Env, "DEV_TEST_ROUTES" | "WORKER_ENV">): boolean {
  const workerEnv = env.WORKER_ENV?.trim().toLowerCase();
  return (
    env.DEV_TEST_ROUTES === "1" &&
    (workerEnv === "development" || workerEnv === "test" || workerEnv === "local")
  );
}

export function devTestRoutesFlag(
  env: Pick<Env, "DEV_TEST_ROUTES" | "WORKER_ENV">,
): "1" | undefined {
  return isDevTestMode(env) ? "1" : undefined;
}
