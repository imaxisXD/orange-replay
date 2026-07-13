import process from "node:process";

const modeEnvironmentName = "ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND";

const expectedStateByBackend = Object.freeze({
  d1: "d1_rollback",
  compare: "compare",
  r2_sql: "fresh",
});

export function readAnalyticsDeployMode(environment = process.env) {
  const backend = environment[modeEnvironmentName]?.trim();
  if (backend === undefined || backend.length === 0) {
    throw new Error(`${modeEnvironmentName} is required. Use d1, compare, or r2_sql.`);
  }

  const expectedState = expectedStateByBackend[backend];
  if (expectedState === undefined) {
    throw new Error(`${modeEnvironmentName} must be d1, compare, or r2_sql.`);
  }

  return { backend, expectedState };
}

export function readAnalyticsSmokeProjectId(environment = process.env) {
  const explicitProjectId = environment.ORANGE_REPLAY_PROD_PROJECT_ID;
  if (explicitProjectId !== undefined && explicitProjectId.length > 0) {
    return checkedProjectId(explicitProjectId, "ORANGE_REPLAY_PROD_PROJECT_ID");
  }

  const allowedProjectIds = environment.ORANGE_REPLAY_PROD_API_PROJECT_IDS;
  const firstAllowedProjectId =
    typeof allowedProjectIds === "string" ? allowedProjectIds.split(",")[0]?.trim() : undefined;
  return checkedProjectId(firstAllowedProjectId, "ORANGE_REPLAY_PROD_API_PROJECT_IDS");
}

function checkedProjectId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(`${name} must include a valid project id.`);
  }
  return value;
}
