const ANALYTICS_CACHE_FORMAT = 1;
const CURRENT_RESULT_SECONDS = 60;
const LAST_GOOD_RESULT_SECONDS = 86_400;

export interface AnalyticsCacheRequests {
  current: Request;
  lastGood: Request;
}

export interface CachedAnalyticsResult<Value> {
  value: Value;
  warehouseVersion: number;
}

interface StoredAnalyticsResult {
  cacheFormat: number;
  warehouseVersion: number;
  value: unknown;
}

/**
 * Reads only values written by writeAnalyticsCache. The expected version is
 * used for the short current-result cache. Last-good reads omit it because
 * their stored warehouse version is part of the response contract.
 */
export async function readAnalyticsCache<Value>(
  request: Request,
  expectedWarehouseVersion?: number,
): Promise<CachedAnalyticsResult<Value> | null> {
  try {
    const response = await caches.default.match(request);
    if (response === undefined || !response.ok) return null;

    const stored = (await response.json()) as unknown;
    if (!isStoredAnalyticsResult(stored)) return null;
    if (
      expectedWarehouseVersion !== undefined &&
      stored.warehouseVersion !== expectedWarehouseVersion
    ) {
      return null;
    }

    return {
      value: stored.value as Value,
      warehouseVersion: stored.warehouseVersion,
    };
  } catch {
    // Cache API support is optional in local and workers.dev environments.
    return null;
  }
}

export function writeAnalyticsCache<Value>(
  ctx: ExecutionContext,
  requests: AnalyticsCacheRequests,
  value: Value,
  warehouseVersion: number,
): void {
  if (!Number.isSafeInteger(warehouseVersion) || warehouseVersion < 0) {
    throw new Error("Warehouse version must be a whole number");
  }

  const body = JSON.stringify({
    cacheFormat: ANALYTICS_CACHE_FORMAT,
    warehouseVersion,
    value,
  } satisfies StoredAnalyticsResult);

  try {
    const write = Promise.all([
      caches.default.put(requests.current, cacheResponse(body, CURRENT_RESULT_SECONDS)),
      caches.default.put(requests.lastGood, cacheResponse(body, LAST_GOOD_RESULT_SECONDS)),
    ])
      .then(() => undefined)
      .catch(() => undefined);
    ctx.waitUntil(write);
  } catch {
    // A cache failure must not make a successful analytics read fail.
  }
}

function cacheResponse(body: string, seconds: number): Response {
  return new Response(body, {
    headers: {
      "cache-control": `public, max-age=${seconds}`,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isStoredAnalyticsResult(value: unknown): value is StoredAnalyticsResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record["cacheFormat"] === ANALYTICS_CACHE_FORMAT &&
    Number.isSafeInteger(record["warehouseVersion"]) &&
    (record["warehouseVersion"] as number) >= 0 &&
    Object.hasOwn(record, "value")
  );
}
