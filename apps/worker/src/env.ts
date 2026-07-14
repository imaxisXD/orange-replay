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

export interface AnalyticsStreamBinding {
  send(records: readonly Record<string, unknown>[]): Promise<void>;
}

export type AnalyticsReadBackend = "d1" | "compare" | "r2_sql";

export interface Env {
  ASSETS?: Fetcher;
  SESSION: DurableObjectNamespace<SessionRecorder>;
  PRESENCE: DurableObjectNamespace<PresenceRegistry>;
  RECORDINGS: R2Bucket;
  CONFIG: KVNamespace;
  IDX_00: D1Database;
  FINALIZE_QUEUE: Queue<FinalizeMessage>;
  /** Structured Cloudflare Pipelines stream. Optional for local/self-host compatibility. */
  ANALYTICS_STREAM?: AnalyticsStreamBinding;
  INGEST_LOOKUP_RATE_LIMITER?: RateLimitBinding;
  INGEST_PROJECT_RATE_LIMITER?: RateLimitBinding;
  INGEST_SESSION_RATE_LIMITER?: RateLimitBinding;
  DEMO_API_RATE_LIMITER?: RateLimitBinding;
  KEY_MANAGEMENT_RATE_LIMITER?: RateLimitBinding;
  PUBLIC_PAGE_RATE_LIMITER?: RateLimitBinding;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** Deployment environment name. Production disables all dev-only test gates. */
  WORKER_ENV?: string;
  /** Explicit analytics reader. Hosted production must set compare or r2_sql after provisioning. */
  ANALYTICS_READ_BACKEND?: AnalyticsReadBackend;
  /** "1" keeps warehouse exports active even while reads temporarily use D1. */
  ANALYTICS_EXPORT_ENABLED?: string;
  /** Server-only R2 SQL REST token. */
  R2_SQL_TOKEN?: string;
  /** Bearer secret shared only with the scheduled physical-deletion runner. */
  ANALYTICS_PURGE_RUNNER_TOKEN?: string;
  R2_SQL_ACCOUNT_ID?: string;
  R2_SQL_BUCKET?: string;
  /** Bearer token for dashboard API auth (v1). Set via local .env / Worker secret. */
  DEV_API_TOKEN?: string;
  /** Comma-separated project ids that DEV_API_TOKEN may access. */
  DEV_API_PROJECT_IDS?: string;
  /** Public origin for Better Auth, without a path. */
  BETTER_AUTH_URL?: string;
  /** At least 32 characters. Used to sign cookies and encrypt OAuth tokens. */
  BETTER_AUTH_SECRET?: string;
  /** Comma-separated exact dashboard origins. Wildcards are not accepted. */
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  /** GitHub OAuth App client id. */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth App client secret. */
  GITHUB_CLIENT_SECRET?: string;
  /** Server-only HMAC secret for live WebSocket tickets. */
  LIVE_TICKET_SECRET?: string;
  /** Public read-only demo project id. Demo is disabled unless this and DEMO_WRITE_KEY are set. */
  DEMO_PROJECT_ID?: string;
  /** Public SDK write key for the demo landing page recorder. */
  DEMO_WRITE_KEY?: string;
  /** Exact public origin used to build share links, for example https://public.example.com. */
  PUBLIC_PAGE_ORIGIN?: string;
  /** "1" enables /__test/* routes. Never set in production config. */
  DEV_TEST_ROUTES?: string;
  /**
   * JSON override for DO timing thresholds, honored only when
   * DEV_TEST_ROUTES === "1": { segmentFlushMs?, segmentFlushBytes?,
   * flushTailMs?, closeMs?, presenceTtlMs?, presenceHeartbeatMs?,
   * sessionHeadGraceMs? }. Lets
   * integration tests shrink the 30-minute idle windows to seconds.
   */
  TEST_TIMINGS?: string;
  /** Dev-only integration hook for one failed Presence head shard. */
  TEST_FAIL_PRESENCE_HEAD_SHARD?: string;
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

export function analyticsReadBackend(
  env: Pick<Env, "ANALYTICS_READ_BACKEND">,
): AnalyticsReadBackend {
  if (
    env.ANALYTICS_READ_BACKEND === "d1" ||
    env.ANALYTICS_READ_BACKEND === "compare" ||
    env.ANALYTICS_READ_BACKEND === "r2_sql"
  )
    return env.ANALYTICS_READ_BACKEND;
  // Warehouse reads are an explicit cutover. A missing value must keep the
  // exact D1 path instead of turning a fresh production deploy into 503s.
  return "d1";
}

export function analyticsExportEnabled(env: Pick<Env, "ANALYTICS_EXPORT_ENABLED">): boolean {
  return env.ANALYTICS_EXPORT_ENABLED === "1";
}

export function devTestRoutesFlag(
  env: Pick<Env, "DEV_TEST_ROUTES" | "WORKER_ENV">,
): "1" | undefined {
  return isDevTestMode(env) ? "1" : undefined;
}
