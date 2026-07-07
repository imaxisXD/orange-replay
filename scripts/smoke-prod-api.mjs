#!/usr/bin/env node
import process from "node:process";

const baseUrlEnv = "ORANGE_REPLAY_PROD_WORKER_URL";
const tokenEnv = "ORANGE_REPLAY_PROD_API_TOKEN";
const projectIdsEnv = "ORANGE_REPLAY_PROD_API_PROJECT_IDS";

try {
  const baseUrl = readBaseUrl();
  const token = readEnv(tokenEnv);
  const projectId = readFirstProjectId();
  const url = new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/config`, baseUrl);

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
    },
    redirect: "manual",
  });

  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`Production API smoke check failed with ${response.status}: ${body}`);
  }

  console.log("Production API smoke check passed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function readBaseUrl() {
  const value = readEnv(baseUrlEnv);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${baseUrlEnv} must be a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${baseUrlEnv} must start with https://.`);
  }
  return url;
}

function readFirstProjectId() {
  const value = readEnv(projectIdsEnv);
  const projectId = value.split(",")[0]?.trim();
  if (projectId === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
    throw new Error(`${projectIdsEnv} must include at least one valid project id.`);
  }
  return projectId;
}

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
