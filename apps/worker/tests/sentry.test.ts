import { describe, expect, it } from "vite-plus/test";
import type { Env } from "../src/env.ts";
import {
  monitoringSampleRate,
  sentryEnabled,
  workerSentryOptions,
} from "../src/observability/sentry.ts";

describe("Worker Sentry settings", () => {
  it("stays disabled without a DSN and never records request bodies", () => {
    const options = workerSentryOptions({ WORKER_ENV: "test" } as Env);

    expect(options).toMatchObject({
      enabled: false,
      environment: "test",
      sampleRate: 1,
      tracesSampleRate: 0.02,
      enableLogs: false,
      enableRpcTracePropagation: false,
      dataCollection: {
        cookies: false,
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
      },
    });
    expect(options.integrations).toEqual([
      expect.objectContaining({ name: "HttpServer", maxRequestBodySize: "none" }),
    ]);
    expect(sentryEnabled({})).toBe(false);
    expect(sentryEnabled({ SENTRY_DSN: "  " })).toBe(false);
  });

  it("uses the deployment version and explicit trace rate when enabled", () => {
    const options = workerSentryOptions({
      SENTRY_DSN: " https://public@example.ingest.sentry.io/1 ",
      SENTRY_ENVIRONMENT: "production",
      SENTRY_TRACES_SAMPLE_RATE: "0.1",
      CF_VERSION_METADATA: { id: "version-id", tag: "release-tag", timestamp: "now" },
    } as Env);

    expect(options).toMatchObject({
      dsn: "https://public@example.ingest.sentry.io/1",
      enabled: true,
      environment: "production",
      release: "release-tag",
      tracesSampleRate: 0.1,
    });
    expect(sentryEnabled({ SENTRY_DSN: "https://public@example.ingest.sentry.io/1" })).toBe(true);
  });

  it("accepts only trace sample rates from zero through one", () => {
    expect(monitoringSampleRate("0", 0.02)).toBe(0);
    expect(monitoringSampleRate("0.5", 0.02)).toBe(0.5);
    expect(monitoringSampleRate("1", 0.02)).toBe(1);
    expect(monitoringSampleRate("-1", 0.02)).toBe(0.02);
    expect(monitoringSampleRate("unknown", 0.02)).toBe(0.02);
  });
});
