import { describe, expect, it } from "vite-plus/test";
import {
  adminUsersQuerySchema,
  countryCodeSchema,
  createProjectKeyRequestSchema,
  generatedRecorderKeySchema,
} from "../src/index.ts";
import {
  allowedOriginSchema,
  deploymentHttpOriginSchema,
  projectConfigUpdateSchema,
} from "../src/project-config-update.ts";

describe("shared client input contracts", () => {
  it("normalizes project key names and enforces every name boundary", () => {
    expect(createProjectKeyRequestSchema.parse({ name: "  Production  " })).toEqual({
      name: "Production",
    });
    expect(createProjectKeyRequestSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createProjectKeyRequestSchema.safeParse({ name: "bad\u0000name" }).success).toBe(false);
    expect(createProjectKeyRequestSchema.safeParse({ name: "a".repeat(64) }).success).toBe(true);
    expect(createProjectKeyRequestSchema.safeParse({ name: "a".repeat(65) }).success).toBe(false);
  });

  it("accepts exact http origins and wildcard, then rejects URL extras", () => {
    expect(allowedOriginSchema.parse(" * ")).toBe("*");
    expect(allowedOriginSchema.parse(" https://app.example.com/ ")).toBe("https://app.example.com");
    expect(deploymentHttpOriginSchema.parse("http://localhost:8787/")).toBe(
      "http://localhost:8787",
    );
    for (const value of [
      "ftp://app.example.com",
      "https://app.example.com/path",
      "https://app.example.com?query=1",
      "https://user@app.example.com",
    ]) {
      expect(allowedOriginSchema.safeParse(value).success).toBe(false);
    }
  });

  it("normalizes the full project config request", () => {
    const parsed = projectConfigUpdateSchema.parse({
      expectedVersion: 1,
      sampleRate: 0.5,
      retentionDays: 30,
      allowedOrigins: [" https://app.example.com/ "],
      maskPolicyVersion: 2,
      maskRules: [{ selector: "  .private  ", action: "mask" }],
      capture: { heatmaps: false, console: false, network: true, canvas: false },
    });
    expect(parsed.allowedOrigins).toEqual(["https://app.example.com"]);
    expect(parsed.maskRules).toEqual([{ selector: ".private", action: "mask" }]);
    expect(
      projectConfigUpdateSchema.safeParse({ ...parsed, allowedOrigins: ["not an origin"] }).success,
    ).toBe(false);
  });

  it("checks the generated recorder key shape", () => {
    const key = `or_live_${"a".repeat(32)}`;
    expect(generatedRecorderKeySchema.parse(` ${key} `)).toBe(key);
    expect(generatedRecorderKeySchema.safeParse(`or_live_${"a".repeat(31)}`).success).toBe(false);
    expect(generatedRecorderKeySchema.safeParse(`or_test_${"a".repeat(32)}`).success).toBe(false);
  });

  it("normalizes and bounds the admin users query", () => {
    expect(adminUsersQuerySchema.parse({ search: "  Sunny  ", limit: "100", offset: "0" })).toEqual(
      { search: "Sunny", limit: 100, offset: 0 },
    );
    expect(adminUsersQuerySchema.safeParse({ search: "x".repeat(101) }).success).toBe(false);
    expect(adminUsersQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(adminUsersQuerySchema.safeParse({ offset: "100001" }).success).toBe(false);
  });

  it("normalizes country codes and preserves Cloudflare special values", () => {
    expect(countryCodeSchema.parse(" us ")).toBe("US");
    expect(countryCodeSchema.parse("XX")).toBe("XX");
    expect(countryCodeSchema.parse("t1")).toBe("T1");
    for (const value of ["", "U", "USA", "1A", "@#"]) {
      expect(countryCodeSchema.safeParse(value).success).toBe(false);
    }
  });
});
