#!/usr/bin/env node
import process from "node:process";

const baseUrlEnv = "ORANGE_REPLAY_PROD_WORKER_URL";

try {
  const baseUrl = readBaseUrl();
  await expectJson(baseUrl, "/api/v1/health", 200, (body) => body?.ok === true);
  await expectJson(baseUrl, "/api/v1/auth/config", 200, (body) => body?.mode === "github");
  await expectJson(baseUrl, "/api/v1/account", 401, (body) => body?.error === "unauthorized");
  await expectJson(
    baseUrl,
    "/api/v1/demo",
    200,
    (body) =>
      typeof body?.projectId === "string" &&
      typeof body?.writeKey === "string" &&
      body.writeKey.startsWith("or_live_"),
  );
  await expectPage(baseUrl, "/login");
  await expectPage(baseUrl, "/demo");

  console.log("Production public demo and signed-out auth smoke checks passed.");
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

async function expectJson(baseUrl, path, expectedStatus, isExpectedBody) {
  const response = await fetch(new URL(path, baseUrl), { redirect: "manual" });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} returned unreadable JSON.`);
  }
  if (response.status !== expectedStatus || !isExpectedBody(body)) {
    throw new Error(`${path} returned an unexpected ${response.status} response.`);
  }
}

async function expectPage(baseUrl, path) {
  const response = await fetch(new URL(path, baseUrl), { redirect: "manual" });
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !contentType.includes("text/html")) {
    throw new Error(`${path} did not return the dashboard page.`);
  }
}

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
