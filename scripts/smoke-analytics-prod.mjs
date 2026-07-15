#!/usr/bin/env node
import process from "node:process";
import { readAnalyticsDeployMode } from "./analytics/deploy-mode.mjs";
import { readStatsAfterDeploy } from "./analytics/smoke-state.mjs";

const MAX_PAGES = 100;

try {
  const baseUrl = httpsOrigin("ORANGE_REPLAY_PROD_WORKER_URL");
  const demo = await apiJson(baseUrl, "/api/v1/demo");
  const projectId = readProjectId(demo.projectId);
  const { expectedState } = readAnalyticsDeployMode();

  const statsPath = `/api/v1/projects/${projectId}/stats`;
  const stats = await readStatsAfterDeploy({
    expectedState,
    readStats: () => apiJson(baseUrl, statsPath),
  });
  const warehouseVersion = optionalWholeNumber(stats.warehouseVersion, "warehouse version");
  if ((expectedState === "compare" || expectedState === "fresh") && warehouseVersion === null) {
    throw new Error("The analytics response did not include a warehouse version.");
  }

  const sessionMetric = readMetric(stats.sessions, "sessions");
  const baseFilter = readFilter(sessionMetric.filter, "sessions filter");
  const sessionIds = await readEverySessionId(
    baseUrl,
    projectId,
    baseFilter,
    warehouseVersion,
    expectedState,
  );
  if (sessionIds.length !== sessionMetric.value) {
    throw new Error(
      `Sessions metric says ${sessionMetric.value}, but its doorway returned ${sessionIds.length}.`,
    );
  }

  const doorway = firstCountDoorway(stats);
  if (doorway !== null) {
    const doorwayIds = await readEverySessionId(
      baseUrl,
      projectId,
      doorway.filter,
      warehouseVersion,
      expectedState,
    );
    if (doorwayIds.length !== doorway.expectedSessions) {
      throw new Error(
        `${doorway.name} says ${doorway.expectedSessions}, but its doorway returned ${doorwayIds.length}.`,
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "analytics.production_smoke",
      analyticsState: expectedState,
      warehouseVersion,
      sessions: sessionIds.length,
      doorway: doorway?.name ?? null,
      result: "pass",
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function readEverySessionId(baseUrl, projectId, filter, warehouseVersion, expectedState) {
  const ids = new Set();
  let before = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) params.set(key, encodeFilterValue(value));
    }
    if (warehouseVersion !== null) params.set("warehouse_version", String(warehouseVersion));
    if (before !== null) params.set("before", before);

    const body = await apiJson(
      baseUrl,
      `/api/v1/projects/${projectId}/sessions?${params.toString()}`,
    );
    if (body.analyticsState !== expectedState) {
      throw new Error("A sessions doorway changed analytics state.");
    }
    if (
      warehouseVersion !== null &&
      optionalWholeNumber(body.warehouseVersion, "sessions warehouse version") !== warehouseVersion
    ) {
      throw new Error("A sessions doorway changed warehouse version.");
    }
    if (!Array.isArray(body.sessions)) throw new Error("Sessions doorway returned invalid data.");
    for (const session of body.sessions) {
      const id = session?.session_id;
      if (typeof id !== "string" || id.length === 0 || ids.has(id)) {
        throw new Error("Sessions doorway returned an invalid or duplicate session id.");
      }
      ids.add(id);
    }
    if (body.nextBefore === null) return [...ids];
    if (typeof body.nextBefore !== "string" || body.nextBefore.length === 0) {
      throw new Error("Sessions doorway returned an invalid cursor.");
    }
    before = body.nextBefore;
  }
  throw new Error("Sessions doorway did not finish within 100 pages.");
}

function firstCountDoorway(stats) {
  for (const [name, rows] of Object.entries(stats.breakdowns ?? {})) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const row = rows[0];
    const count = readMetric(row?.count, `${name} count`);
    return {
      name: `${name}:${String(row?.label)}`,
      expectedSessions: count.value,
      filter: readFilter(count.filter, `${name} filter`),
    };
  }
  if (Array.isArray(stats.errors) && stats.errors.length > 0) {
    const row = stats.errors[0];
    const affected = readMetric(row?.affectedSessions, "error affected sessions");
    return {
      name: `error:${String(row?.detail)}`,
      expectedSessions: affected.value,
      filter: readFilter(affected.filter, "error filter"),
    };
  }
  return null;
}

async function apiJson(baseUrl, path) {
  const response = await fetch(new URL(path, baseUrl), {
    redirect: "manual",
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} returned unreadable JSON.`);
  }
  if (response.status !== 200 || body === null || typeof body !== "object") {
    throw new Error(`${path} returned an unexpected ${response.status} response.`);
  }
  return body;
}

function readProjectId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error("Demo discovery returned an invalid project id.");
  }
  return value;
}

function readMetric(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.value) ||
    value.value < 0
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function readFilter(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function encodeFilterValue(value) {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string" || Number.isSafeInteger(value)) return String(value);
  throw new Error("A metric returned an invalid filter value.");
}

function optionalWholeNumber(value, label) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function httpsOrigin(name) {
  const value = requiredText(name);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !new Set(["", "/"]).has(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin without a path.`);
  }
  return url;
}

function requiredText(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
