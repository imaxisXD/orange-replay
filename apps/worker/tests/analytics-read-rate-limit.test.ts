import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ANALYTICS_GLOBAL_BUDGET_SQL,
  ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE,
  checkAnalyticsReadRateLimit,
} from "../src/analytics/read-rate-limit.ts";

type BudgetDatabase = NonNullable<Parameters<typeof checkAnalyticsReadRateLimit>[0]["IDX_00"]>;

describe("analytics read rate limit", () => {
  it("checks hashed actor and project budgets", async () => {
    const actorLimit = allowLimiter();
    const projectLimit = allowLimiter();
    const locationLimit = allowLimiter();

    await expect(
      checkAnalyticsReadRateLimit(
        {
          ANALYTICS_ACTOR_RATE_LIMITER: { limit: actorLimit },
          ANALYTICS_PROJECT_RATE_LIMITER: { limit: projectLimit },
          ANALYTICS_GLOBAL_RATE_LIMITER: { limit: locationLimit },
          ANALYTICS_READ_BACKEND: "d1",
        },
        "user:private-user-id",
        "private-project-id",
      ),
    ).resolves.toEqual({ allowed: true });

    const actorKey = actorLimit.mock.calls[0]?.[0].key;
    const projectKey = projectLimit.mock.calls[0]?.[0].key;
    expect(actorKey).toMatch(/^analytics:actor:[a-f0-9]{64}$/);
    expect(projectKey).toMatch(/^analytics:project:[a-f0-9]{64}$/);
    expect(actorKey).not.toContain("private-user-id");
    expect(projectKey).not.toContain("private-project-id");
    expect(locationLimit).not.toHaveBeenCalled();
  });

  it("does not consume wider budgets after an actor rejection", async () => {
    const actorLimit = denyLimiter();
    const projectLimit = allowLimiter();
    const locationLimit = allowLimiter();
    const budget = makeBudgetDatabase({ requestCount: 1 });

    await expect(
      checkAnalyticsReadRateLimit(
        warehouseEnvironment(actorLimit, projectLimit, locationLimit, budget.database),
        "user:one",
        "project-one",
      ),
    ).resolves.toEqual({ allowed: false, scope: "actor" });

    expect(projectLimit).not.toHaveBeenCalled();
    expect(locationLimit).not.toHaveBeenCalled();
    expect(budget.prepare).not.toHaveBeenCalled();
  });

  it("does not consume shared budgets after a project rejection", async () => {
    const actorLimit = allowLimiter();
    const projectLimit = denyLimiter();
    const locationLimit = allowLimiter();
    const budget = makeBudgetDatabase({ requestCount: 1 });

    await expect(
      checkAnalyticsReadRateLimit(
        warehouseEnvironment(actorLimit, projectLimit, locationLimit, budget.database),
        "user:one",
        "project-one",
      ),
    ).resolves.toEqual({ allowed: false, scope: "project" });

    expect(locationLimit).not.toHaveBeenCalled();
    expect(budget.prepare).not.toHaveBeenCalled();
  });

  it("uses an exact D1 budget after the per-location warehouse guard", async () => {
    const budget = makeBudgetDatabase({ requestCount: 1 });

    await expect(
      checkAnalyticsReadRateLimit(
        warehouseEnvironment(allowLimiter(), allowLimiter(), allowLimiter(), budget.database),
        "user:one",
        "project-one",
        120_001,
      ),
    ).resolves.toEqual({ allowed: true });

    expect(budget.prepare).toHaveBeenCalledOnce();
    expect(budget.bind).toHaveBeenCalledWith(120_000, ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE);
  });

  it("reports an exhausted exact warehouse budget", async () => {
    const budget = makeBudgetDatabase(null);

    await expect(
      checkAnalyticsReadRateLimit(
        warehouseEnvironment(allowLimiter(), allowLimiter(), allowLimiter(), budget.database),
        "user:one",
        "project-one",
      ),
    ).resolves.toEqual({ allowed: false, scope: "global" });
  });

  it("never lets a delayed old-window request roll the exact budget backward", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE analytics_read_budget (
        scope TEXT PRIMARY KEY CHECK (scope = 'warehouse_global'),
        window_start INTEGER NOT NULL CHECK (window_start >= 0),
        request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 600)
      )`);
      const consume = database.prepare(ANALYTICS_GLOBAL_BUDGET_SQL);

      expect(consume.get(60_000, ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE)).toEqual({
        requestCount: 1,
      });
      expect(consume.get(120_000, ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE)).toEqual({
        requestCount: 1,
      });
      expect(consume.get(60_000, ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE)).toBeUndefined();
      expect(consume.get(120_000, ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE)).toEqual({
        requestCount: 2,
      });
      for (
        let requestCount = 3;
        requestCount <= ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE;
        requestCount += 1
      ) {
        consume.get(120_000, ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE);
      }
      expect(consume.get(120_000, ANALYTICS_GLOBAL_REQUESTS_PER_MINUTE)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("allows the largest production demo smoke without using the signed-in actor tier", async () => {
    const projectLimit = countingLimiter(300);
    const locationLimit = countingLimiter(600);
    const budget = makeBudgetDatabase({ requestCount: 1 });

    for (let request = 0; request < 201; request += 1) {
      await expect(
        checkAnalyticsReadRateLimit(
          {
            ANALYTICS_PROJECT_RATE_LIMITER: { limit: projectLimit },
            ANALYTICS_GLOBAL_RATE_LIMITER: { limit: locationLimit },
            ANALYTICS_READ_BACKEND: "r2_sql",
            IDX_00: budget.database,
          },
          null,
          "demo-project",
        ),
      ).resolves.toEqual({ allowed: true });
    }

    expect(projectLimit).toHaveBeenCalledTimes(201);
    expect(locationLimit).toHaveBeenCalledTimes(201);
    expect(budget.prepare).toHaveBeenCalledTimes(201);
  });

  it("fails closed outside explicit local test mode", async () => {
    await expect(checkAnalyticsReadRateLimit({}, "user:one", "project-one")).resolves.toEqual({
      allowed: false,
      scope: "configuration",
    });
    await expect(
      checkAnalyticsReadRateLimit(
        { DEV_TEST_ROUTES: "1", WORKER_ENV: "test" },
        "user:one",
        "project-one",
      ),
    ).resolves.toEqual({ allowed: true });
  });
});

function allowLimiter() {
  return vi.fn(async (_request: { key: string }) => ({ success: true }));
}

function denyLimiter() {
  return vi.fn(async (_request: { key: string }) => ({ success: false }));
}

function countingLimiter(limit: number) {
  let count = 0;
  return vi.fn(async (_request: { key: string }) => {
    count += 1;
    return { success: count <= limit };
  });
}

type TestLimit = (request: { key: string }) => Promise<{ success: boolean }>;

function warehouseEnvironment(
  actorLimit: TestLimit,
  projectLimit: TestLimit,
  locationLimit: TestLimit,
  database: BudgetDatabase,
) {
  return {
    ANALYTICS_ACTOR_RATE_LIMITER: { limit: actorLimit },
    ANALYTICS_PROJECT_RATE_LIMITER: { limit: projectLimit },
    ANALYTICS_GLOBAL_RATE_LIMITER: { limit: locationLimit },
    ANALYTICS_READ_BACKEND: "r2_sql",
    IDX_00: database,
  };
}

function makeBudgetDatabase(result: { requestCount: number } | null) {
  const first = vi.fn(async () => result);
  const bind = vi.fn((_windowStart: number, _limit: number) => ({ first }));
  const prepare = vi.fn((_query: string) => ({ bind }));
  return {
    bind,
    database: { prepare } as unknown as BudgetDatabase,
    prepare,
  };
}
