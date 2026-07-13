import { describe, expect, it } from "vite-plus/test";
import type { Env } from "../src/env.ts";
import {
  jurisdictionAllowsDefaultAnalytics,
  projectAnalyticsReadMode,
} from "../src/analytics/residency.ts";

describe("analytics residency", () => {
  it("allows only projects without a restricted jurisdiction", () => {
    expect(jurisdictionAllowsDefaultAnalytics(null)).toBe(true);
    expect(jurisdictionAllowsDefaultAnalytics(undefined)).toBe(false);
    expect(jurisdictionAllowsDefaultAnalytics("")).toBe(false);
    expect(jurisdictionAllowsDefaultAnalytics("eu")).toBe(false);
    expect(jurisdictionAllowsDefaultAnalytics("fedramp")).toBe(false);
    expect(jurisdictionAllowsDefaultAnalytics("unknown")).toBe(false);
  });

  it("fails closed when warehouse reads do not have matching exports", async () => {
    await expect(
      projectAnalyticsReadMode(testEnv(null, "r2_sql", "0"), "project"),
    ).resolves.toEqual({ ok: false, error: "analytics_configuration_invalid", status: 503 });
    await expect(
      projectAnalyticsReadMode(testEnv(null, "compare", "1"), "project"),
    ).resolves.toEqual({ ok: false, error: "analytics_configuration_invalid", status: 503 });
  });

  it("keeps restricted and missing projects on D1", async () => {
    await expect(
      projectAnalyticsReadMode(testEnv("eu", "r2_sql", "0"), "project"),
    ).resolves.toEqual({ ok: true, backend: "d1", state: "d1_residency" });
    await expect(
      projectAnalyticsReadMode(testEnv(undefined, "r2_sql", "0"), "project"),
    ).resolves.toEqual({ ok: true, backend: "d1", state: "d1_residency" });
  });

  it("allows compare only when the default project can be exported", async () => {
    const env = testEnv(null, "compare", "1");
    env.ANALYTICS_STREAM = { async send() {} };
    await expect(projectAnalyticsReadMode(env, "project")).resolves.toEqual({
      ok: true,
      backend: "compare",
      state: "compare",
    });
  });
});

function testEnv(
  jurisdiction: string | null | undefined,
  backend: "d1" | "compare" | "r2_sql",
  exportEnabled: string,
): Env {
  return {
    ANALYTICS_EXPORT_ENABLED: exportEnabled,
    ANALYTICS_READ_BACKEND: backend,
    IDX_00: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return jurisdiction === undefined ? null : { jurisdiction };
          },
        };
      },
    } as unknown as Env["IDX_00"],
  } as Env;
}
