const KNOWN_ANALYTICS_STATES = new Set([
  "d1_rollback",
  "d1_residency",
  "compare",
  "fresh",
  "stale",
]);

export const MAX_STATE_CHECKS = 6;
export const STATE_CHECK_WAIT_MS = 2_000;

export async function readStatsAfterDeploy({
  expectedState,
  readStats,
  wait = waitForMilliseconds,
  reportRetry = console.warn,
}) {
  for (let checkNumber = 1; checkNumber <= MAX_STATE_CHECKS; checkNumber += 1) {
    const stats = await readStats();
    const currentState = stats?.analyticsState;
    if (currentState === expectedState) return stats;

    // Only a complete response from the previous Worker version is safe to
    // retry. Network, JSON, HTTP, and invalid-state failures stay immediate.
    if (!KNOWN_ANALYTICS_STATES.has(currentState)) {
      throw new Error(`Analytics state is ${String(currentState)}; expected ${expectedState}.`);
    }
    if (checkNumber === MAX_STATE_CHECKS) {
      throw new Error(
        `Cloudflare did not reach analytics state ${expectedState} after ${MAX_STATE_CHECKS} checks; the last state was ${currentState}.`,
      );
    }

    reportRetry(
      `Analytics state is still ${currentState}; expected ${expectedState}. Waiting ${STATE_CHECK_WAIT_MS / 1_000} seconds for Cloudflare deployment (check ${checkNumber} of ${MAX_STATE_CHECKS}).`,
    );
    await wait(STATE_CHECK_WAIT_MS);
  }

  throw new Error("Analytics state check ended unexpectedly.");
}

function waitForMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
