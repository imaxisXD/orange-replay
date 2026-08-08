import { describe, expect, it } from "vite-plus/test";
import { parseSdkHealthReport, SDK_HEALTH_PROTOCOL_VERSION } from "../src/sdk-health.ts";

describe("SDK health report", () => {
  it("accepts an allow-listed failure code", () => {
    expect(
      parseSdkHealthReport({ version: SDK_HEALTH_PROTOCOL_VERSION, code: "config_failed" }),
    ).toEqual({ version: 1, code: "config_failed" });
  });

  it.each([
    { version: 1, code: "unknown" },
    { version: 2, code: "config_failed" },
    { version: 1, code: "config_failed", url: "https://private.example/account" },
    { version: 1, code: "config_failed", message: "private error" },
  ])("rejects unsupported or private fields: %j", (value) => {
    expect(parseSdkHealthReport(value)).toBeNull();
  });
});
