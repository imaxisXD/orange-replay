import { describe, expect, it } from "vite-plus/test";
import { dashboardSentryOptions, monitoringSampleRate } from "../src/lib/sentry.ts";

describe("dashboard Sentry settings", () => {
  it("keeps error reports on and Sentry Session Replay off", () => {
    const options = dashboardSentryOptions({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "test",
      tracesSampleRate: 0.05,
    });

    expect(options).toMatchObject({
      sampleRate: 1,
      tracesSampleRate: 0.05,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      enableLogs: false,
      dataCollection: {
        cookies: false,
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
      },
      initialScope: { tags: { surface: "dashboard" } },
    });
  });

  it("accepts only trace sample rates from zero through one", () => {
    expect(monitoringSampleRate("0", 0.05)).toBe(0);
    expect(monitoringSampleRate("0.25", 0.05)).toBe(0.25);
    expect(monitoringSampleRate("1", 0.05)).toBe(1);
    expect(monitoringSampleRate("2", 0.05)).toBe(0.05);
    expect(monitoringSampleRate("not-a-number", 0.05)).toBe(0.05);
  });
});
