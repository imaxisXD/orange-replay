// Finalize-queue consumer — implemented by T1.4 (see PLAN.md). This module
// owns src/consumer/** and src/test/consumer-routes.ts, nothing else.
import type { Env, FinalizeMessage } from "../env.ts";

export function handleFinalizeBatch(
  batch: MessageBatch<FinalizeMessage>,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // TODO(T1.4): idempotent D1 upserts, usage rollups, per-message ack/retry, DLQ.
  for (const message of batch.messages) message.retry();
  return Promise.resolve();
}
