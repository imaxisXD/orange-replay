export const productionAcceptanceArguments = Object.freeze([
  "--database",
  "orange-replay-idx-00-prod",
  "--bucket",
  "orange-replay-analytics-prod",
  "--config",
  "apps/worker/wrangler.cloudflare-build.jsonc",
  "--env",
  "production",
]);

export function needsAnalyticsCutoverCheck(backend) {
  return backend === "compare" || backend === "r2_sql";
}

export function exactWorkerR2TokenEnvironment(environment, workerR2Token) {
  const gateEnvironment = {
    ...environment,
    ORANGE_REPLAY_PROD_R2_SQL_TOKEN: workerR2Token,
  };
  delete gateEnvironment.ORANGE_REPLAY_R2_SQL_READ_TOKEN;
  delete gateEnvironment.WRANGLER_R2_SQL_AUTH_TOKEN;
  return gateEnvironment;
}
