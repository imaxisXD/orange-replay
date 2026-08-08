import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { unstable_dev } from "wrangler";

const workerDir = fileURLToPath(new URL("..", import.meta.url));

let collector: Server;
let worker: Awaited<ReturnType<typeof unstable_dev>>;
let errorEnvelope: Promise<string>;

beforeAll(async () => {
  let resolveErrorEnvelope: (body: string) => void = () => undefined;
  errorEnvelope = new Promise((resolve) => {
    resolveErrorEnvelope = resolve;
  });

  collector = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.includes("Orange Replay Sentry test error.")) resolveErrorEnvelope(body);
      response.statusCode = 200;
      response.end("ok");
    });
  });
  await new Promise<void>((resolve, reject) => {
    collector.once("error", reject);
    collector.listen(0, "127.0.0.1", resolve);
  });

  const address = collector.address();
  if (address === null || typeof address === "string") {
    throw new Error("The local Sentry test collector did not open a TCP port.");
  }

  worker = await unstable_dev(`${workerDir}src/observability/entry.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: {
      DEV_TEST_ROUTES: "1",
      SENTRY_DSN: `http://testpublickey@127.0.0.1:${address.port}/1`,
      SENTRY_TRACES_SAMPLE_RATE: "1",
    },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await new Promise<void>((resolve, reject) => {
    collector?.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("Sentry Worker error cycle", () => {
  it("sends a guarded test error without request secrets", async () => {
    const response = await worker.fetch("/__test/sentry-error?customer-token=query-secret", {
      headers: {
        authorization: "Bearer header-secret",
        cookie: "session=cookie-secret",
      },
    });
    expect(response.status).toBe(500);

    const envelope = await Promise.race([
      errorEnvelope,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Sentry did not send the test error.")), 10_000);
      }),
    ]);

    expect(envelope).toContain("Orange Replay Sentry test error.");
    expect(envelope).toContain("/__test/sentry-error");
    expect(envelope).not.toContain("query-secret");
    expect(envelope).not.toContain("header-secret");
    expect(envelope).not.toContain("cookie-secret");
  }, 20_000);
});
