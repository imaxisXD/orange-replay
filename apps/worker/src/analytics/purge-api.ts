import { startWideEvent, uuidv7 } from "@orange-replay/shared";
import { outcomeForStatus } from "../api/helpers.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "../api/http.ts";
import { shardDb, type Env } from "../env.ts";
import {
  claimAnalyticsPurgeJobs,
  MAX_PURGE_CLAIM_JOBS,
  MAX_PURGE_REPORT_JOBS,
  markPurgeDeadlineAlerted,
  reportAnalyticsPurgeResults,
  type AnalyticsPurgeResult,
} from "./purge-jobs.ts";

const CLAIM_PATH = "/internal/analytics/purge/claim";
const REPORT_PATH = "/internal/analytics/purge/report";
const MAX_BODY_BYTES = 16 * 1024;
const MIN_TOKEN_CHARS = 32;
const MAX_TOKEN_CHARS = 512;
const ownerPattern = /^[A-Za-z0-9_.:-]{1,200}$/;
const pathIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const encoder = new TextEncoder();

interface ClaimRequestBody {
  ownerId: string;
  limit: number;
}

interface ReportRequestBody {
  ownerId: string;
  results: AnalyticsPurgeResult[];
}

export function isAnalyticsPurgeApiPath(pathname: string): boolean {
  return pathname === CLAIM_PATH || pathname === REPORT_PATH;
}

/** Internal API used only by the scheduled Iceberg deletion runner. */
export async function handleAnalyticsPurgeApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname === CLAIM_PATH ? "claim" : "report";
  const wideEvent = startWideEvent("worker", "analytics.purge_api", uuidv7());
  let statusCode = 500;

  wideEvent.set({ route, method: request.method });

  try {
    let response: Response;
    if (!isAnalyticsPurgeApiPath(url.pathname)) {
      response = jsonError("not_found", 404);
    } else if (request.method !== "POST") {
      response = jsonError("method_not_allowed", 405, { allow: "POST" });
    } else {
      const authError = purgeRunnerAuthError(request, env);
      response =
        authError ?? (await handleAuthorizedRequest(request, url.pathname, env, wideEvent));
    }
    statusCode = response.status;
    return response;
  } catch (error) {
    wideEvent.fail(error);
    const response = jsonError("internal_error", 500);
    statusCode = response.status;
    return response;
  } finally {
    wideEvent.set({ status_code: statusCode });
    wideEvent.emit(outcomeForStatus(statusCode));
  }
}

async function handleAuthorizedRequest(
  request: Request,
  pathname: string,
  env: Env,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, MAX_BODY_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);

  const db = shardDb(env, 0);
  if (pathname === CLAIM_PATH) {
    const input = parseClaimBody(body.value);
    if (input === null) return jsonError("invalid_request", 400);

    const claimed = await claimAnalyticsPurgeJobs(db, input.ownerId, Date.now(), input.limit);
    const alertsRecorded = claimed.deadlineRisk ? await markPurgeDeadlineAlerted(db) : 0;
    wideEvent.set({
      owner_id: input.ownerId,
      jobs_claimed: claimed.jobs.length,
      deadline_risk: claimed.deadlineRisk,
      deadline_alerts_recorded: alertsRecorded,
    });
    return noStoreJson({
      jobs: claimed.jobs.map((job) => ({
        project_id: job.projectId,
        session_id: job.sessionId,
        requested_at: job.requestedAt,
        delete_reason: job.deleteReason,
        requires_warehouse_tombstone: job.requiresWarehouseTombstone,
        needs_physical_maintenance: job.needsPhysicalMaintenance,
      })),
      deadline_risk: claimed.deadlineRisk,
      oldest_pending_at: claimed.oldestPendingAt,
      deadline_alerts_recorded: alertsRecorded,
    });
  }

  const input = parseReportBody(body.value);
  if (input === null) return jsonError("invalid_request", 400);
  const reported = await reportAnalyticsPurgeResults(db, input.ownerId, input.results);
  wideEvent.set({
    owner_id: input.ownerId,
    jobs_reported: input.results.length,
    jobs_completed: reported.completed,
    jobs_waiting_for_second_check: reported.waitingForSecondCheck,
    jobs_failed: reported.failed,
  });
  return noStoreJson({
    completed: reported.completed,
    waiting_for_second_check: reported.waitingForSecondCheck,
    failed: reported.failed,
  });
}

function purgeRunnerAuthError(request: Request, env: Env): Response | null {
  const expectedToken = readRunnerToken(env.ANALYTICS_PURGE_RUNNER_TOKEN);
  if (expectedToken === null) {
    return jsonError("analytics_purge_not_configured", 503);
  }

  const header = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (header === null || !header.startsWith(prefix)) {
    return jsonError("unauthorized", 401, { "www-authenticate": "Bearer" });
  }

  const expected = encoder.encode(expectedToken);
  const actual = encoder.encode(header.slice(prefix.length));
  return timingSafeEqual(expected, actual)
    ? null
    : jsonError("unauthorized", 401, { "www-authenticate": "Bearer" });
}

function readRunnerToken(value: string | undefined): string | null {
  if (
    typeof value !== "string" ||
    value.length < MIN_TOKEN_CHARS ||
    value.length > MAX_TOKEN_CHARS ||
    value.trim() !== value ||
    value.startsWith("REPLACE_WITH_")
  ) {
    return null;
  }
  return value;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function parseClaimBody(value: unknown): ClaimRequestBody | null {
  if (!isObjectWithOnlyKeys(value, ["owner_id", "limit"])) return null;
  const ownerId = value["owner_id"];
  const limit = value["limit"] ?? 1;
  if (
    typeof ownerId !== "string" ||
    !ownerPattern.test(ownerId) ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PURGE_CLAIM_JOBS
  ) {
    return null;
  }
  return { ownerId, limit };
}

function parseReportBody(value: unknown): ReportRequestBody | null {
  if (!isObjectWithOnlyKeys(value, ["owner_id", "results"])) return null;
  const ownerId = value["owner_id"];
  const results = value["results"];
  if (
    typeof ownerId !== "string" ||
    !ownerPattern.test(ownerId) ||
    !Array.isArray(results) ||
    results.length < 1 ||
    results.length > MAX_PURGE_REPORT_JOBS
  ) {
    return null;
  }

  const checked: AnalyticsPurgeResult[] = [];
  const seenJobs = new Set<string>();
  for (const item of results) {
    if (
      !isObjectWithOnlyKeys(item, [
        "project_id",
        "session_id",
        "rows_remaining",
        "rows_found_before",
        "error",
      ]) ||
      typeof item["project_id"] !== "string" ||
      !pathIdPattern.test(item["project_id"]) ||
      typeof item["session_id"] !== "string" ||
      !pathIdPattern.test(item["session_id"]) ||
      typeof item["rows_remaining"] !== "number" ||
      !Number.isSafeInteger(item["rows_remaining"]) ||
      item["rows_remaining"] < 0 ||
      typeof item["rows_found_before"] !== "number" ||
      !Number.isSafeInteger(item["rows_found_before"]) ||
      item["rows_found_before"] < 0 ||
      (item["error"] !== undefined &&
        (typeof item["error"] !== "string" || item["error"].length > 500))
    ) {
      return null;
    }
    const jobKey = `${item["project_id"]}\u0000${item["session_id"]}`;
    if (seenJobs.has(jobKey)) return null;
    seenJobs.add(jobKey);
    checked.push({
      projectId: item["project_id"],
      sessionId: item["session_id"],
      rowsRemaining: item["rows_remaining"],
      rowsFoundBefore: item["rows_found_before"],
      ...(item["error"] === undefined ? {} : { error: item["error"] }),
    });
  }
  return { ownerId, results: checked };
}

function isObjectWithOnlyKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function noStoreJson(body: unknown): Response {
  return jsonResponse(body, { headers: { "cache-control": "no-store" } });
}
