import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { handleAnalyticsPurgeApi } from "../src/analytics/purge-api.ts";
import { ANALYTICS_PURGE_ALERT_MS, ANALYTICS_PURGE_QUIET_MS } from "../src/analytics/purge-jobs.ts";
import type { Env } from "../src/env.ts";
import {
  createPurgeTestDatabase,
  type PurgeTestDatabase,
} from "./analytics-purge-test-database.ts";

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const TOKEN = "purge-runner-token-00000000000000000000";
const CLAIM_URL = "https://replay.example/internal/analytics/purge/claim";
const REPORT_URL = "https://replay.example/internal/analytics/purge/report";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analytics physical deletion API", () => {
  it("fails closed when its secret is missing and rejects a wrong bearer token", async () => {
    muteWideEvents();
    const database = await createPurgeTestDatabase();

    const missing = await handleAnalyticsPurgeApi(
      jsonRequest(CLAIM_URL, { owner_id: "runner" }),
      purgeEnv(database),
    );
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: "analytics_purge_not_configured" });

    const wrong = await handleAnalyticsPurgeApi(
      jsonRequest(CLAIM_URL, { owner_id: "runner" }, "wrong-token"),
      purgeEnv(database, TOKEN),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toBe("Bearer");
    expect(await wrong.json()).toEqual({ error: "unauthorized" });
    database.close();
  });

  it("accepts POST only and rejects unknown or oversized request fields", async () => {
    muteWideEvents();
    const database = await createPurgeTestDatabase();
    const env = purgeEnv(database, TOKEN);

    const method = await handleAnalyticsPurgeApi(new Request(CLAIM_URL), env);
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");

    const unknownField = await handleAnalyticsPurgeApi(
      jsonRequest(CLAIM_URL, { owner_id: "runner", unexpected: true }, TOKEN),
      env,
    );
    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toEqual({ error: "invalid_request" });

    const oversized = await handleAnalyticsPurgeApi(
      jsonRequest(CLAIM_URL, { owner_id: "x".repeat(17 * 1024) }, TOKEN),
      env,
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "body_too_large" });
    database.close();
  });

  it("claims one job, records deadline alerts, and accepts its verified result", async () => {
    muteWideEvents();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const database = await createPurgeTestDatabase();
    seedJob(database, NOW - ANALYTICS_PURGE_ALERT_MS - 1);
    const env = purgeEnv(database, TOKEN);

    const claim = await handleAnalyticsPurgeApi(
      jsonRequest(CLAIM_URL, { owner_id: "runner-123", limit: 1 }, TOKEN),
      env,
    );
    expect(claim.status).toBe(200);
    expect(claim.headers.get("cache-control")).toBe("no-store");
    expect(await claim.json()).toEqual({
      jobs: [
        {
          project_id: "missing-project",
          session_id: "session",
          requested_at: NOW - ANALYTICS_PURGE_ALERT_MS - 1,
          delete_reason: "delete_requested",
          requires_warehouse_tombstone: false,
          needs_physical_maintenance: true,
        },
      ],
      deadline_risk: true,
      oldest_pending_at: NOW - ANALYTICS_PURGE_ALERT_MS - 1,
      deadline_alerts_recorded: 1,
    });
    expect(database.value("SELECT alerted_at FROM analytics_deletion_jobs")).toBe(NOW);

    const report = await handleAnalyticsPurgeApi(
      jsonRequest(
        REPORT_URL,
        {
          owner_id: "runner-123",
          results: [
            {
              project_id: "missing-project",
              session_id: "session",
              rows_remaining: 0,
              rows_found_before: 0,
            },
          ],
        },
        TOKEN,
      ),
      env,
    );
    expect(report.status).toBe(200);
    expect(await report.json()).toEqual({
      completed: 0,
      waiting_for_second_check: 1,
      failed: 0,
    });
    expect(
      database.row("SELECT first_zero_at, completed_at, lease_owner FROM analytics_deletion_jobs"),
    ).toEqual({ first_zero_at: NOW, completed_at: null, lease_owner: null });
    database.close();
  });

  it("claims 500 jobs and reports results in groups of 20", async () => {
    muteWideEvents();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const database = await createPurgeTestDatabase();
    for (let index = 0; index < 500; index += 1) {
      seedJob(
        database,
        NOW - ANALYTICS_PURGE_QUIET_MS - 1,
        `session-${String(index).padStart(3, "0")}`,
      );
    }
    const env = purgeEnv(database, TOKEN);

    const claim = await handleAnalyticsPurgeApi(
      jsonRequest(CLAIM_URL, { owner_id: "batch-runner", limit: 500 }, TOKEN),
      env,
    );
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as {
      jobs: Array<{ project_id: string; session_id: string }>;
    };
    expect(claimed.jobs).toHaveLength(500);

    const report = await handleAnalyticsPurgeApi(
      jsonRequest(
        REPORT_URL,
        {
          owner_id: "batch-runner",
          results: claimed.jobs.slice(0, 20).map((job) => ({
            project_id: job.project_id,
            session_id: job.session_id,
            rows_remaining: 0,
            rows_found_before: 0,
          })),
        },
        TOKEN,
      ),
      env,
    );
    expect(report.status).toBe(200);
    expect(await report.json()).toEqual({
      completed: 0,
      waiting_for_second_check: 20,
      failed: 0,
    });
    database.close();
  });

  it("rejects a report with invalid ids or an empty result list", async () => {
    muteWideEvents();
    const database = await createPurgeTestDatabase();
    const env = purgeEnv(database, TOKEN);

    for (const results of [
      [],
      [{ project_id: "project", session_id: "session", rows_remaining: 0 }],
      [
        {
          project_id: "bad/id",
          session_id: "session",
          rows_remaining: 0,
          rows_found_before: 0,
        },
      ],
      [
        {
          project_id: "project",
          session_id: "session",
          rows_remaining: -1,
          rows_found_before: 0,
        },
      ],
      [
        {
          project_id: "project",
          session_id: "session",
          rows_remaining: 0,
          rows_found_before: -1,
        },
      ],
      [
        {
          project_id: "project",
          session_id: "session",
          rows_remaining: 0,
          rows_found_before: 0,
        },
        {
          project_id: "project",
          session_id: "session",
          rows_remaining: 0,
          rows_found_before: 0,
        },
      ],
    ]) {
      const response = await handleAnalyticsPurgeApi(
        jsonRequest(REPORT_URL, { owner_id: "runner", results }, TOKEN),
        env,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    database.close();
  });
});

function muteWideEvents(): void {
  vi.spyOn(globalThis.console, "log").mockImplementation(() => undefined);
  vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
}

function purgeEnv(database: PurgeTestDatabase, token?: string): Env {
  return {
    IDX_00: database,
    ANALYTICS_PURGE_RUNNER_TOKEN: token,
  } as unknown as Env;
}

function jsonRequest(url: string, body: unknown, token?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

function seedJob(database: PurgeTestDatabase, requestedAt: number, sessionId = "session"): void {
  expect(requestedAt).toBeLessThanOrEqual(NOW - ANALYTICS_PURGE_QUIET_MS);
  database.run(
    `INSERT INTO analytics_deletion_jobs (
      project_id, session_id, requested_at, delete_reason, requires_warehouse_tombstone
    ) VALUES ('missing-project', ?, ?, 'delete_requested', 0)`,
    sessionId,
    requestedAt,
  );
}
