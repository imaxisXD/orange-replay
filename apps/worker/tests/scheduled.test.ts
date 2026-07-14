import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { maintainAnalyticsWarehouse } from "../src/analytics/maintenance.ts";
import { sweepProjectKeyCache } from "../src/consumer/key-cache-sweeper.ts";
import { sweepExpiredSessions } from "../src/consumer/sweeper.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import { RETENTION_SWEEP_SCHEDULE } from "../src/schedules.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

vi.mock("../src/analytics/maintenance.ts", () => ({
  maintainAnalyticsWarehouse: vi.fn(async () => undefined),
}));

vi.mock("../src/consumer/sweeper.ts", () => ({
  sweepExpiredSessions: vi.fn(async () => undefined),
}));

vi.mock("../src/consumer/key-cache-sweeper.ts", () => ({
  sweepProjectKeyCache: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("scheduled Worker jobs", () => {
  it("runs retention and analytics maintenance on the 15-minute retention schedule", async () => {
    await runSchedule(RETENTION_SWEEP_SCHEDULE);

    expect(RETENTION_SWEEP_SCHEDULE).toBe("7,22,37,52 * * * *");
    expect(sweepExpiredSessions).toHaveBeenCalledTimes(1);
    expect(maintainAnalyticsWarehouse).toHaveBeenCalledTimes(1);
    expect(sweepProjectKeyCache).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sweepExpiredSessions).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(maintainAnalyticsWarehouse).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps the five-minute analytics job separate from retention", async () => {
    await runSchedule("*/5 * * * *");

    expect(sweepExpiredSessions).not.toHaveBeenCalled();
    expect(maintainAnalyticsWarehouse).toHaveBeenCalledTimes(1);
    expect(sweepProjectKeyCache).toHaveBeenCalledTimes(1);
  });
});

async function runSchedule(cron: string): Promise<void> {
  const pendingJobs: Promise<unknown>[] = [];
  const context = {
    waitUntil(job: Promise<unknown>) {
      pendingJobs.push(job);
    },
  } as Parameters<typeof worker.scheduled>[2];

  await worker.scheduled({ cron } as Parameters<typeof worker.scheduled>[0], {} as Env, context);
  await Promise.all(pendingJobs);
}
