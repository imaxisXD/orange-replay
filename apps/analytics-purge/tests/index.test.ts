import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildContainerEnvironment,
  redactedContainerError,
  startScheduledPurge,
  type SchedulerEnvironment,
} from "../src/scheduler.ts";

function validEnvironment(overrides: Partial<SchedulerEnvironment> = {}): SchedulerEnvironment {
  return {
    ORANGE_REPLAY_PURGE_API_URL: "https://orangereplay.app",
    ANALYTICS_PURGE_RUNNER_TOKEN: "r".repeat(40),
    R2_CATALOG_URI: "https://catalog.cloudflarestorage.com/iceberg",
    R2_SQL_WAREHOUSE: "orange-replay-analytics-prod",
    ORANGE_REPLAY_CATALOG_TOKEN: "c".repeat(40),
    CF_VERSION_METADATA: {
      id: "test-version",
      tag: "test",
      timestamp: "2026-08-06T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("analytics purge scheduler", () => {
  it("passes only the five required values to the container", () => {
    expect(buildContainerEnvironment(validEnvironment())).toEqual({
      ORANGE_REPLAY_PURGE_API_URL: "https://orangereplay.app",
      ANALYTICS_PURGE_RUNNER_TOKEN: "r".repeat(40),
      R2_CATALOG_URI: "https://catalog.cloudflarestorage.com/iceberg",
      R2_SQL_WAREHOUSE: "orange-replay-analytics-prod",
      ORANGE_REPLAY_CATALOG_TOKEN: "c".repeat(40),
    });
  });

  it("starts the container without putting secrets in labels", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const env = validEnvironment();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await startScheduledPurge(env, "*/15 * * * *", { start });

    expect(start).toHaveBeenCalledWith({
      envVars: buildContainerEnvironment(env),
      enableInternet: true,
      labels: { service: "analytics-purge" },
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: "container.start",
      cron: "*/15 * * * *",
      start_requested: true,
      outcome: "success",
    });
    log.mockRestore();
  });

  it("does not start when a required value is missing", async () => {
    const start = vi.fn();
    const env = validEnvironment({
      ORANGE_REPLAY_CATALOG_TOKEN: "",
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(startScheduledPurge(env, "*/15 * * * *", { start })).rejects.toThrow(
      "ORANGE_REPLAY_CATALOG_TOKEN is required",
    );

    expect(start).not.toHaveBeenCalled();
    expect(String(errorLog.mock.calls[0]?.[0])).not.toContain("r".repeat(40));
    errorLog.mockRestore();
  });

  it("removes every runtime value from a logged Container error", () => {
    const env = validEnvironment();
    const error = new Error(`failed ${env.ANALYTICS_PURGE_RUNNER_TOKEN} at ${env.R2_CATALOG_URI}`);

    expect(redactedContainerError(error, env).message).toBe("failed [hidden] at [hidden]");
  });

  it("does not rethrow an unredacted Container start error", async () => {
    const env = validEnvironment();
    const start = vi
      .fn()
      .mockRejectedValue(
        new Error(`could not pass ${env.ORANGE_REPLAY_CATALOG_TOKEN} to the Container`),
      );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(startScheduledPurge(env, "*/15 * * * *", { start })).rejects.toThrow(
      "could not pass [hidden] to the Container",
    );
    expect(String(errorLog.mock.calls[0]?.[0])).not.toContain(env.ORANGE_REPLAY_CATALOG_TOKEN);
    errorLog.mockRestore();
  });
});
