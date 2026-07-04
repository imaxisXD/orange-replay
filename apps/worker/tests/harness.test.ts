// Integration harness smoke: boots the real worker via wrangler unstable_dev
// (workerd + local bindings) and exercises every binding through the guarded
// /__test/harness route. This is the test pattern for all worker integration
// tests (vitest-pool-workers is incompatible with Vite Plus' vitest 4).
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { unstable_dev } from "wrangler";

const workerDir = fileURLToPath(new URL("..", import.meta.url));

let worker: Awaited<ReturnType<typeof unstable_dev>>;

beforeAll(async () => {
  worker = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: { DEV_TEST_ROUTES: "1" },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
});

describe("worker harness", () => {
  it("serves the root route", async () => {
    const res = await worker.fetch("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; ok: boolean };
    expect(body.service).toBe("orange-replay");
  });

  it("exercises DO, Presence DO, R2, KV, and D1 bindings", async () => {
    const res = await worker.fetch("/__test/harness");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      do: string;
      presence: boolean;
      r2: boolean;
      kv: boolean;
      d1: number;
    };
    expect(body).toEqual({ do: "pong", presence: true, r2: true, kv: true, d1: 1 });
  });

  it("rejects a header-less ingest post at the edge", async () => {
    const res = await worker.fetch("/v1/ingest", { method: "POST" });
    expect(res.status).toBe(400);
  });
});
