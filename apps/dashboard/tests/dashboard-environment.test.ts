import { describe, expect, it } from "vite-plus/test";
import { getDashboardEnvironmentLabel } from "../src/lib/dashboard-environment";

describe("dashboard environment label", () => {
  it("labels the public demo", () => {
    expect(getDashboardEnvironmentLabel(true, "production")).toBe("Demo");
  });

  it("labels local development", () => {
    expect(getDashboardEnvironmentLabel(false, "local")).toBe("Local dev");
    expect(getDashboardEnvironmentLabel(false, undefined)).toBe("Local dev");
  });

  it("labels a production build", () => {
    expect(getDashboardEnvironmentLabel(false, "production")).toBe("Production");
  });
});
