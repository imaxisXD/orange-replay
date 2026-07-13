import { DatabaseSync, type StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  releaseAnalyticsLease,
  renewAnalyticsLease,
  reserveAnalyticsSendWindow,
  tryAcquireAnalyticsLease,
} from "../src/analytics/lease.ts";
import { createRateLimitedAnalyticsPipeline } from "../src/analytics/rate-limited-pipeline.ts";

describe("analytics export lease", () => {
  it("allows only one sender and recovers after lease expiry", async () => {
    const database = new TestD1Database();
    database.sqlite.exec(
      `CREATE TABLE analytics_export_lease (
        shard INTEGER PRIMARY KEY CHECK (shard = 0),
        owner_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        send_available_at INTEGER NOT NULL DEFAULT 0
      )`,
    );
    const db = database as unknown as Parameters<typeof tryAcquireAnalyticsLease>[0];

    const firstClaims = await Promise.all([
      tryAcquireAnalyticsLease(db, "worker-a", 100, 100),
      tryAcquireAnalyticsLease(db, "worker-b", 100, 100),
    ]);
    expect(firstClaims.filter(Boolean)).toHaveLength(1);
    const winner = firstClaims[0] ? "worker-a" : "worker-b";
    const loser = winner === "worker-a" ? "worker-b" : "worker-a";

    await expect(renewAnalyticsLease(db, winner, 150, 100)).resolves.toBe(true);
    await expect(tryAcquireAnalyticsLease(db, loser, 249, 100)).resolves.toBe(false);
    await expect(tryAcquireAnalyticsLease(db, loser, 250, 100)).resolves.toBe(true);
    await releaseAnalyticsLease(db, winner, 251);
    await expect(renewAnalyticsLease(db, loser, 260, 100)).resolves.toBe(true);

    database.sqlite.close();
  });
});

describe("analytics Pipeline rate limit", () => {
  it("paces every request below the configured byte rate", async () => {
    let currentTime = 1_000;
    const waits: number[] = [];
    const send = vi.fn(async () => {});
    const pipeline = createRateLimitedAnalyticsPipeline(
      { send },
      {
        bytesPerSecond: 1_000,
        now: () => currentTime,
        async wait(milliseconds) {
          waits.push(milliseconds);
          currentTime += milliseconds;
        },
      },
    );
    const record = { export_id: "one", detail: "x".repeat(400) };

    await pipeline.send([record] as never);
    await pipeline.send([record] as never);
    await pipeline.send([record] as never);

    expect(send).toHaveBeenCalledTimes(3);
    expect(waits).toHaveLength(2);
    expect(waits.every((milliseconds) => milliseconds >= 400)).toBe(true);
  });

  it("renews the sender lease during work longer than its first lease", async () => {
    const database = new TestD1Database();
    database.sqlite.exec(
      `CREATE TABLE analytics_export_lease (
        shard INTEGER PRIMARY KEY,
        owner_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        send_available_at INTEGER NOT NULL DEFAULT 0
      )`,
    );
    const db = database as unknown as Parameters<typeof tryAcquireAnalyticsLease>[0];
    let currentTime = 100;
    await expect(tryAcquireAnalyticsLease(db, "worker-a", currentTime, 100)).resolves.toBe(true);
    const pipeline = createRateLimitedAnalyticsPipeline(
      { async send() {} },
      {
        bytesPerSecond: 1_000,
        now: () => currentTime,
        async wait(milliseconds) {
          currentTime += milliseconds;
        },
        async beforeSend() {
          const renewed = await renewAnalyticsLease(db, "worker-a", currentTime, 100);
          if (!renewed) throw new Error("lease expired");
        },
      },
    );
    const record = { export_id: "one", detail: "x".repeat(60) };

    await pipeline.send([record] as never);
    await pipeline.send([record] as never);
    await pipeline.send([record] as never);

    expect(currentTime).toBeGreaterThan(200);
    await expect(tryAcquireAnalyticsLease(db, "worker-b", currentTime, 100)).resolves.toBe(false);
    database.sqlite.close();
  });

  it("keeps the stream rate safe across two Worker invocations", async () => {
    const database = new TestD1Database();
    database.sqlite.exec(
      `CREATE TABLE analytics_export_lease (
        shard INTEGER PRIMARY KEY,
        owner_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        send_available_at INTEGER NOT NULL DEFAULT 0
      )`,
    );
    const db = database as unknown as Parameters<typeof tryAcquireAnalyticsLease>[0];
    let currentTime = 1_000;
    await expect(tryAcquireAnalyticsLease(db, "worker-a", currentTime, 10_000)).resolves.toBe(true);

    const firstWait = await reserveAnalyticsSendWindow(
      db,
      "worker-a",
      4_000,
      4_000,
      currentTime,
      10_000,
    );
    expect(firstWait).toBe(0);
    await releaseAnalyticsLease(db, "worker-a", currentTime + 10);

    await expect(tryAcquireAnalyticsLease(db, "worker-b", currentTime + 10, 10_000)).resolves.toBe(
      false,
    );
    currentTime += 1_000;
    await expect(tryAcquireAnalyticsLease(db, "worker-b", currentTime, 10_000)).resolves.toBe(true);
    const secondWait = await reserveAnalyticsSendWindow(
      db,
      "worker-b",
      4_000,
      4_000,
      currentTime,
      10_000,
    );
    expect(secondWait).toBe(0);

    database.sqlite.close();
  });

  it("rejects a request larger than the Cloudflare limit before sending", async () => {
    const send = vi.fn(async () => {});
    const pipeline = createRateLimitedAnalyticsPipeline({ send });

    await expect(
      pipeline.send([{ export_id: "large", detail: "x".repeat(5_000_000) }] as never),
    ).rejects.toThrow("larger than 5 MB");
    expect(send).not.toHaveBeenCalled();
  });
});

type SqlValue = string | number | bigint | Uint8Array | null;

class TestD1Database {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(query: string): TestD1Statement {
    return new TestD1Statement(this.sqlite.prepare(query));
  }
}

class TestD1Statement {
  private values: SqlValue[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: SqlValue[]): TestD1Statement {
    this.values = values;
    return this;
  }

  async first<Row extends Record<string, unknown>>(): Promise<Row | null> {
    return (this.statement.get(...this.values) as Row | undefined) ?? null;
  }

  async run(): Promise<void> {
    this.statement.run(...this.values);
  }
}
