import { isDevTestMode, type Env } from "../env.ts";
import { sha256Hex } from "./helpers.ts";

export async function ingestRateLimitAllows(
  env: Env,
  limiter: Env["INGEST_LOOKUP_RATE_LIMITER"],
  scope: string,
): Promise<boolean> {
  if (limiter === undefined) {
    return isDevTestMode(env);
  }

  const key = await sha256Hex(scope);
  try {
    const result = await limiter.limit({ key });
    return result.success;
  } catch {
    return false;
  }
}

export function ingestIpRateLimitAllows(
  env: Env,
  limiter: Env["INGEST_LOOKUP_RATE_LIMITER"],
  request: Request,
  scope: string,
): Promise<boolean> {
  const source = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  return ingestRateLimitAllows(env, limiter, `${scope}:ip:${source}`);
}
