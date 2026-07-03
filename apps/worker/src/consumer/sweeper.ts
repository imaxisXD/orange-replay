// Retention sweeper (cron) — implemented by T1.4 (see PLAN.md).
import type { Env } from "../env.ts";

export function sweepExpiredSessions(_env: Env): Promise<void> {
  // TODO(T1.4): expired sessions from D1 -> R2 prefix delete (paginated, truncated-aware) -> D1 row delete.
  return Promise.resolve();
}
