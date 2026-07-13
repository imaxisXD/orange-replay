import { startWideEvent } from "@orange-replay/shared";

export const ANALYTICS_COMPARE_QUERY_TIMEOUT_MS = 10_000;

export type AnalyticsCompareEvent = ReturnType<typeof startWideEvent>;

export type AnalyticsCompareRoute = "project_stats" | "sessions_list";

interface AnalyticsCompareInput {
  projectId: string;
  requestId: string;
  route: AnalyticsCompareRoute;
  warehouseVersion?: number;
}

type AnalyticsCompareOutcome = "success" | "server_error";

/**
 * D1 keeps a small error sample for replay search. It cannot prove the exact
 * session set for one error message, while the warehouse keeps every sidecar
 * error. Treat that filter as useful shadow data, not a mismatch.
 */
export function canCompareD1Exactly(filter: { error_detail?: string }): boolean {
  return filter.error_detail === undefined;
}

/**
 * Keeps the warehouse shadow read outside the user response while preserving
 * one complete event for the comparison work itself.
 */
export function runAnalyticsCompareInBackground(
  ctx: ExecutionContext,
  input: AnalyticsCompareInput,
  compare: (event: AnalyticsCompareEvent) => Promise<AnalyticsCompareOutcome | void>,
): void {
  const event = startWideEvent("worker", "analytics.compare", input.requestId);
  event.set({
    project_id: input.projectId,
    analytics_compare_route: input.route,
    ...(input.warehouseVersion === undefined ? {} : { warehouse_version: input.warehouseVersion }),
  });

  const work = (async () => {
    let outcome: "success" | "server_error" = "success";
    try {
      const compareOutcome = await compare(event);
      if (compareOutcome !== undefined) outcome = compareOutcome;
    } catch (error) {
      outcome = "server_error";
      event.fail(error);
      event.set({
        analytics_compare_status: "unavailable",
        analytics_compare_error: safeAnalyticsCompareError(error),
      });
    } finally {
      event.emit(outcome);
    }
  })();

  ctx.waitUntil(work);
}

function safeAnalyticsCompareError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown analytics compare error";
  return message.slice(0, 500);
}
