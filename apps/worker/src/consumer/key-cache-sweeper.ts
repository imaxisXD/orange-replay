import { startWideEvent, uuidv7, type WideEventOutcome } from "@orange-replay/shared";
import { repairActiveProjectKeyCache } from "../api/project-config.ts";
import { maintainProjectKeyCache } from "../api/project-key-cache.ts";
import { setWorkerLoggerVersion, type Env } from "../env.ts";

export async function sweepProjectKeyCache(env: Env): Promise<void> {
  setWorkerLoggerVersion(env);
  const wideEvent = startWideEvent("worker", "consumer.key_cache_sweep", uuidv7());
  let outcome: WideEventOutcome = "success";

  try {
    const activeRepaired = await repairActiveProjectKeyCache(env);
    const result = await maintainProjectKeyCache(env);
    wideEvent.set({
      active_key_caches_repaired: activeRepaired,
      key_caches_repaired: result.repaired,
      key_caches_rechecked: result.rechecked,
      key_audit_rows_deleted: result.auditRowsDeleted,
    });
  } catch (error) {
    outcome = "server_error";
    wideEvent.fail(error);
    throw error;
  } finally {
    wideEvent.emit(outcome);
  }
}
