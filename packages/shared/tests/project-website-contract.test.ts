import { describe, expect, it } from "vite-plus/test";
import {
  ensureProjectWebsiteRequestSchema,
  ensureProjectWebsiteResponseSchema,
} from "../src/project-website-contract.ts";

describe("project Website contract", () => {
  it("normalizes a bare domain for both dashboard and Worker", () => {
    const parsed = ensureProjectWebsiteRequestSchema.parse({ website: "  app.example.com  " });
    expect(parsed.website.href).toBe("https://app.example.com/");
  });

  it("rejects unsafe schemes and extra request fields", () => {
    expect(
      ensureProjectWebsiteRequestSchema.safeParse({ website: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(
      ensureProjectWebsiteRequestSchema.safeParse({ website: "example.com", admin: true }).success,
    ).toBe(false);
  });

  it("allows a connected Website to omit its no-longer-recoverable raw key", () => {
    expect(
      ensureProjectWebsiteResponseSchema.safeParse({
        website: {
          id: "website_1",
          name: "example.com",
          origin: "https://example.com",
          firstEventAt: 1,
        },
        key: null,
        secret: null,
        alreadyConnected: true,
      }).success,
    ).toBe(true);
  });
});
