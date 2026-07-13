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
  return backend === "r2_sql";
}
