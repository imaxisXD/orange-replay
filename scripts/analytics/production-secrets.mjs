const secretDefinitions = Object.freeze([
  Object.freeze({
    workerName: "DEV_API_TOKEN",
    environmentName: "ORANGE_REPLAY_PROD_API_TOKEN",
    kind: "secret",
  }),
  Object.freeze({
    workerName: "DEV_API_PROJECT_IDS",
    environmentName: "ORANGE_REPLAY_PROD_API_PROJECT_IDS",
    kind: "project_ids",
  }),
  Object.freeze({
    workerName: "LIVE_TICKET_SECRET",
    environmentName: "ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET",
    kind: "secret",
  }),
  Object.freeze({
    workerName: "R2_SQL_TOKEN",
    environmentName: "ORANGE_REPLAY_PROD_R2_SQL_TOKEN",
    kind: "secret",
  }),
  Object.freeze({
    workerName: "ANALYTICS_PURGE_RUNNER_TOKEN",
    environmentName: "ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN",
    kind: "secret",
  }),
]);

const pathIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export const cloudflareAuthEnvironmentNames = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  "CF_API_TOKEN",
]);

export const productionWorkerSecretNames = Object.freeze(
  secretDefinitions.map((definition) => definition.workerName),
);

export const productionSecretEnvironmentNames = Object.freeze(
  secretDefinitions.map((definition) => definition.environmentName),
);

const extraSensitiveEnvironmentNames = Object.freeze([
  "ORANGE_REPLAY_CATALOG_TOKEN",
  "ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN",
  "ORANGE_REPLAY_R2_INVENTORY_TOKEN",
  "ORANGE_REPLAY_R2_SQL_READ_TOKEN",
  "ORANGE_REPLAY_PROD_WRITE_KEY",
  "WRANGLER_R2_SQL_AUTH_TOKEN",
]);

export function readProductionSecretValues(environment = process.env) {
  return Object.fromEntries(
    secretDefinitions.map((definition) => [
      definition.workerName,
      definition.kind === "project_ids"
        ? readValidProjectIds(environment[definition.environmentName], definition.environmentName)
        : readValidSecret(environment[definition.environmentName], definition.environmentName),
    ]),
  );
}

export function readProductionR2SqlToken(environment = process.env) {
  return readValidSecret(
    environment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN,
    "ORANGE_REPLAY_PROD_R2_SQL_TOKEN",
  );
}

export function readProductionSmokeValues(environment = process.env) {
  const projectIds = readValidProjectIds(
    environment.ORANGE_REPLAY_PROD_API_PROJECT_IDS,
    "ORANGE_REPLAY_PROD_API_PROJECT_IDS",
  );
  const allowedProjectIds = projectIds.split(",");
  const requestedProjectId = environment.ORANGE_REPLAY_PROD_PROJECT_ID;
  const smokeProjectId =
    requestedProjectId === undefined || requestedProjectId.length === 0
      ? allowedProjectIds[0]
      : readValidSmokeProjectId(requestedProjectId, allowedProjectIds);

  return {
    apiToken: readValidSecret(
      environment.ORANGE_REPLAY_PROD_API_TOKEN,
      "ORANGE_REPLAY_PROD_API_TOKEN",
    ),
    projectIds,
    smokeProjectId,
    workerOrigin: readValidHttpsOrigin(environment.ORANGE_REPLAY_PROD_WORKER_URL),
  };
}

export function readWorkerDeploySecrets(environment = process.env, options = {}) {
  if (options.cloudflareBuild !== true) return readProductionSecretValues(environment);

  const backend = environment.ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND;
  if (backend !== "compare" && backend !== "r2_sql") return {};
  return { R2_SQL_TOKEN: readProductionR2SqlToken(environment) };
}

export function withoutProductionSecrets(environment = process.env) {
  const cleanEnvironment = { ...environment };
  for (const name of [
    ...productionSecretEnvironmentNames,
    ...productionWorkerSecretNames,
    ...extraSensitiveEnvironmentNames,
  ]) {
    delete cleanEnvironment[name];
  }
  return cleanEnvironment;
}

export function withoutCloudflareAuth(environment = process.env) {
  const cleanEnvironment = { ...environment };
  for (const name of cloudflareAuthEnvironmentNames) delete cleanEnvironment[name];
  return cleanEnvironment;
}

function readValidSecret(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required before production deploy.`);
  }
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters.`);
  }
  if (value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error(`${name} must not include surrounding space or new lines.`);
  }
  return value;
}

function readValidProjectIds(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required before production deploy.`);
  }

  const projectIds = value.split(",").map((part) => part.trim());
  if (projectIds.some((projectId) => projectId.length === 0)) {
    throw new Error(`${name} must be a comma-separated list without empty values.`);
  }
  for (const projectId of projectIds) {
    if (!pathIdPattern.test(projectId)) {
      throw new Error(`${name} contains an invalid project id: ${projectId}`);
    }
  }
  return [...new Set(projectIds)].join(",");
}

function readValidSmokeProjectId(projectId, allowedProjectIds) {
  if (!pathIdPattern.test(projectId)) {
    throw new Error("ORANGE_REPLAY_PROD_PROJECT_ID must be a valid project id.");
  }
  if (!allowedProjectIds.includes(projectId)) {
    throw new Error("ORANGE_REPLAY_PROD_PROJECT_ID must be in ORANGE_REPLAY_PROD_API_PROJECT_IDS.");
  }
  return projectId;
}

function readValidHttpsOrigin(value) {
  const name = "ORANGE_REPLAY_PROD_WORKER_URL";
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} is required before production deploy.`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !new Set(["", "/"]).has(url.pathname) ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.origin === "null"
  ) {
    throw new Error(`${name} must be a clean HTTPS origin without a path, query, or login.`);
  }
  return url.origin;
}
