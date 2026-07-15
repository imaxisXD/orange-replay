const secretDefinitions = Object.freeze([
  Object.freeze({
    workerName: "BETTER_AUTH_SECRET",
    environmentName: "ORANGE_REPLAY_PROD_BETTER_AUTH_SECRET",
    kind: "secret",
  }),
  Object.freeze({
    workerName: "BETTER_AUTH_URL",
    environmentName: "ORANGE_REPLAY_PROD_BETTER_AUTH_URL",
    kind: "origin",
  }),
  Object.freeze({
    workerName: "BETTER_AUTH_TRUSTED_ORIGINS",
    environmentName: "ORANGE_REPLAY_PROD_BETTER_AUTH_TRUSTED_ORIGINS",
    kind: "trusted_origins",
  }),
  Object.freeze({
    workerName: "GITHUB_CLIENT_ID",
    environmentName: "ORANGE_REPLAY_PROD_GITHUB_CLIENT_ID",
    kind: "secret",
    minimumLength: 10,
  }),
  Object.freeze({
    workerName: "GITHUB_CLIENT_SECRET",
    environmentName: "ORANGE_REPLAY_PROD_GITHUB_CLIENT_SECRET",
    kind: "secret",
    minimumLength: 20,
  }),
  Object.freeze({
    workerName: "LIVE_TICKET_SECRET",
    environmentName: "ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET",
    kind: "secret",
  }),
  Object.freeze({
    workerName: "DEMO_PROJECT_ID",
    environmentName: "ORANGE_REPLAY_DEMO_PROJECT_ID",
    kind: "project_id",
  }),
  Object.freeze({
    workerName: "DEMO_WRITE_KEY",
    environmentName: "ORANGE_REPLAY_DEMO_WRITE_KEY",
    kind: "write_key",
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
    maximumLength: 512,
  }),
]);

const pathIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const writeKeyPattern = /^or_live_[A-Za-z0-9_-]{32}$/;

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

export const retiredProductionWorkerSecretNames = Object.freeze([
  "DEV_API_TOKEN",
  "DEV_API_PROJECT_IDS",
]);

const extraSensitiveEnvironmentNames = Object.freeze([
  "DEV_API_PROJECT_IDS",
  "DEV_API_TOKEN",
  "ORANGE_REPLAY_CATALOG_TOKEN",
  "ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN",
  "ORANGE_REPLAY_PROD_API_PROJECT_IDS",
  "ORANGE_REPLAY_PROD_API_TOKEN",
  "ORANGE_REPLAY_R2_INVENTORY_TOKEN",
  "ORANGE_REPLAY_R2_SQL_READ_TOKEN",
  "ORANGE_REPLAY_PROD_WRITE_KEY",
  "WRANGLER_R2_SQL_AUTH_TOKEN",
]);

export function readProductionSecretValues(environment = process.env) {
  const values = {};
  for (const definition of secretDefinitions) {
    const value = environment[definition.environmentName];
    if (definition.kind === "project_id") {
      values[definition.workerName] = readValidProjectId(value, definition.environmentName);
    } else if (definition.kind === "write_key") {
      values[definition.workerName] = readValidWriteKey(value, definition.environmentName);
    } else if (definition.kind === "origin") {
      values[definition.workerName] = readValidHttpsOrigin(value, definition.environmentName);
    } else if (definition.kind === "trusted_origins") {
      values[definition.workerName] = readValidTrustedOrigins(
        value,
        definition.environmentName,
        values.BETTER_AUTH_URL,
      );
    } else {
      values[definition.workerName] = readValidSecret(value, definition.environmentName, {
        maximumLength: definition.maximumLength,
        minimumLength: definition.minimumLength,
      });
    }
  }

  const workerOrigin = readValidHttpsOrigin(
    environment.ORANGE_REPLAY_PROD_WORKER_URL,
    "ORANGE_REPLAY_PROD_WORKER_URL",
  );
  if (values.BETTER_AUTH_URL !== workerOrigin) {
    throw new Error(
      "ORANGE_REPLAY_PROD_BETTER_AUTH_URL must exactly match ORANGE_REPLAY_PROD_WORKER_URL.",
    );
  }
  return values;
}

export function readProductionR2SqlToken(environment = process.env) {
  return readValidSecret(
    environment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN,
    "ORANGE_REPLAY_PROD_R2_SQL_TOKEN",
  );
}

export function readProductionSmokeValues(environment = process.env) {
  return {
    workerOrigin: readValidHttpsOrigin(
      environment.ORANGE_REPLAY_PROD_WORKER_URL,
      "ORANGE_REPLAY_PROD_WORKER_URL",
    ),
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

function readValidSecret(value, name, options = {}) {
  const maximumLength = options.maximumLength ?? 4096;
  const minimumLength = options.minimumLength ?? 32;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required before production deploy.`);
  }
  if (value.length < minimumLength) {
    throw new Error(`${name} must be at least ${minimumLength} characters.`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${name} must be at most ${maximumLength} characters.`);
  }
  if (value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error(`${name} must not include surrounding space or new lines.`);
  }
  if (value.startsWith("REPLACE_WITH_") || value.startsWith("your-")) {
    throw new Error(`${name} must not use a placeholder value.`);
  }
  return value;
}

function readValidProjectId(value, name) {
  if (typeof value !== "string" || !pathIdPattern.test(value)) {
    throw new Error(`${name} must use only letters, numbers, _ or -.`);
  }
  return value;
}

function readValidWriteKey(value, name) {
  if (typeof value !== "string" || !writeKeyPattern.test(value)) {
    throw new Error(`${name} must be a generated key that starts with or_live_.`);
  }
  return value;
}

function readValidTrustedOrigins(value, name, authOrigin) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required before production deploy.`);
  }
  const origins = [...new Set(value.split(",").map((part) => part.trim()))];
  if (origins.some((origin) => origin.length === 0)) {
    throw new Error(`${name} must not contain an empty origin.`);
  }
  const validOrigins = origins.map((origin) => readValidHttpsOrigin(origin, name));
  if (!validOrigins.includes(authOrigin)) {
    throw new Error(`${name} must include ORANGE_REPLAY_PROD_BETTER_AUTH_URL.`);
  }
  return validOrigins.join(",");
}

function readValidHttpsOrigin(value, name) {
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
