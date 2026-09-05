import { isDevTestMode, type RateLimitBinding } from "../env.ts";

interface AnalyticsReadRateLimitEnv {
  ANALYTICS_ACTOR_RATE_LIMITER?: RateLimitBinding;
  ANALYTICS_PROJECT_RATE_LIMITER?: RateLimitBinding;
  ANALYTICS_GLOBAL_RATE_LIMITER?: RateLimitBinding;
  ANALYTICS_READ_BACKEND?: string;
  DEV_TEST_ROUTES?: string;
  IDX_00?: D1Database;
  WORKER_ENV?: string;
}

export type AnalyticsReadRateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      scope: "actor" | "project" | "location" | "global" | "configuration";
    };

export const ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE = 600;
const RATE_LIMIT_WINDOW_MS = 60_000;
export const ANALYTICS_GLOBAL_BUDGET_SQL = `INSERT INTO analytics_read_budget (
  scope, window_start, request_count
)
VALUES ('warehouse_global', ?, 1)
ON CONFLICT(scope) DO UPDATE SET
  window_start = excluded.window_start,
  request_count = CASE
    WHEN analytics_read_budget.window_start = excluded.window_start
    THEN analytics_read_budget.request_count + 1
    ELSE 1
  END
WHERE analytics_read_budget.window_start < excluded.window_start
  OR (
    analytics_read_budget.window_start = excluded.window_start
    AND analytics_read_budget.request_count < ?
  )
RETURNING request_count AS requestCount`;

/**
 * Applies per-person and per-project limits before checking cached analytics.
 * Raw user, IP, and project identifiers never leave the Worker in limiter keys.
 */
export async function checkAnalyticsReadRateLimit(
  env: AnalyticsReadRateLimitEnv,
  actorIdentity: string | null,
  projectId: string,
): Promise<AnalyticsReadRateLimitResult> {
  if (isDevTestMode(env)) return { allowed: true };

  const actorLimiter = env.ANALYTICS_ACTOR_RATE_LIMITER;
  const projectLimiter = env.ANALYTICS_PROJECT_RATE_LIMITER;
  if ((actorIdentity !== null && actorLimiter === undefined) || projectLimiter === undefined) {
    return { allowed: false, scope: "configuration" };
  }

  try {
    if (actorIdentity !== null) {
      const actor = await actorLimiter?.limit({
        key: `analytics:actor:${await sha256Hex(actorIdentity)}`,
      });
      if (actor?.success !== true) return { allowed: false, scope: "actor" };
    }

    const project = await projectLimiter.limit({
      key: `analytics:project:${await sha256Hex(projectId)}`,
    });
    if (!project.success) return { allowed: false, scope: "project" };

    return { allowed: true };
  } catch {
    return { allowed: false, scope: "configuration" };
  }
}

/** Reserve shared capacity only when a read will actually query the warehouse. */
export async function checkWarehouseReadCapacity(
  env: AnalyticsReadRateLimitEnv,
  now = Date.now(),
): Promise<AnalyticsReadRateLimitResult> {
  if (isDevTestMode(env)) return { allowed: true };
  try {
    const locationLimiter = env.ANALYTICS_GLOBAL_RATE_LIMITER;
    if (locationLimiter === undefined || env.IDX_00 === undefined) {
      return { allowed: false, scope: "configuration" };
    }
    const location = await locationLimiter.limit({ key: "analytics:warehouse:location" });
    if (!location.success) return { allowed: false, scope: "location" };

    const globalAllowed = await consumeGlobalWarehouseBudget(env.IDX_00, now);
    if (!globalAllowed) return { allowed: false, scope: "global" };
    return { allowed: true };
  } catch {
    return { allowed: false, scope: "configuration" };
  }
}

async function consumeGlobalWarehouseBudget(database: D1Database, now: number): Promise<boolean> {
  if (!Number.isSafeInteger(now) || now < 0) return false;
  const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  const row = await database
    .prepare(ANALYTICS_GLOBAL_BUDGET_SQL)
    .bind(windowStart, ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE)
    .first<{ requestCount: number }>();
  return row !== null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
