import { describe, expect, it } from "vite-plus/test";
import { parseStoredWebsiteOrigins } from "../src/project-config/website-origins.ts";

describe("stored Website origins", () => {
  it("reads the canonical origins written for a Website", () => {
    expect(parseStoredWebsiteOrigins('["https://example.com","https://www.example.com"]')).toEqual([
      "https://example.com",
      "https://www.example.com",
    ]);
  });

  it.each([
    '["*"]',
    '["https://example.com/path"]',
    '["https://example.com","https://example.com"]',
    "[]",
  ])("rejects invalid stored origins: %s", (value) => {
    expect(() => parseStoredWebsiteOrigins(value)).toThrow("Stored Website origins are invalid.");
  });

  it("reports unreadable JSON separately", () => {
    expect(() => parseStoredWebsiteOrigins("not-json")).toThrow(
      "Stored Website origins are not valid JSON.",
    );
  });
});
