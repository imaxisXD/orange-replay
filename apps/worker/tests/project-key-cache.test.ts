import { describe, expect, it } from "vite-plus/test";
import type { Env } from "../src/env.ts";
import { projectConfigDeliveryTestHooks } from "../src/project-config/delivery.ts";

const { syncRevokedKeyCache } = projectConfigDeliveryTestHooks;
type KeyCacheDatabase = Parameters<typeof syncRevokedKeyCache>[1];

describe("revoked key cache repair", () => {
  it("leaves a durable pending marker when the KV delete fails", async () => {
    const steps: string[] = [];
    let cacheSynced = 1;
    let cachedKeyIsActive = true;
    let deleteShouldFail = true;
    const database = fakeDatabase((sql) => {
      if (sql.includes("cache_synced = 0")) {
        steps.push("mark pending");
        cacheSynced = 0;
        return;
      }
      if (sql.includes("cache_synced = 1")) {
        steps.push("mark synced");
        cacheSynced = 1;
      }
    });
    const env = {
      CONFIG: {
        delete: async () => {
          steps.push("delete cache");
          if (deleteShouldFail) throw new Error("Injected KV delete failure");
          cachedKeyIsActive = false;
        },
      },
    } as unknown as Env;

    await expect(syncRevokedKeyCache(env, database, "hash_1")).rejects.toThrow(
      "Injected KV delete failure",
    );
    expect(steps).toEqual(["mark pending", "delete cache"]);
    expect(cacheSynced).toBe(0);
    expect(cachedKeyIsActive).toBe(true);

    deleteShouldFail = false;
    await syncRevokedKeyCache(env, database, "hash_1");
    expect(steps.slice(-3)).toEqual(["mark pending", "delete cache", "mark synced"]);
    expect(cacheSynced).toBe(1);
    expect(cachedKeyIsActive).toBe(false);
  });
});

function fakeDatabase(onRun: (sql: string) => void): KeyCacheDatabase {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        run: async () => {
          onRun(sql);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as unknown as KeyCacheDatabase;
}
