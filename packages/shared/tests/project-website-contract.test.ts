import { describe, expect, it } from "vite-plus/test";
import {
  ensureProjectWebsiteRequestSchema,
  ensureProjectWebsiteResponseSchema,
  projectWebsitesResponseSchema,
} from "../src/project-website-contract.ts";

describe("project Website contract", () => {
  it("normalizes a bare domain for both dashboard and Worker", () => {
    const parsed = ensureProjectWebsiteRequestSchema.parse({ website: "  app.example.com  " });
    expect(parsed.website.href).toBe("https://app.example.com/");
    expect(parsed.websiteId).toBeUndefined();
  });

  it("accepts the exact unfinished Website being edited", () => {
    const parsed = ensureProjectWebsiteRequestSchema.parse({
      website: "next.example.com",
      websiteId: "website_123",
    });
    expect(parsed).toEqual({
      website: new URL("https://next.example.com"),
      websiteId: "website_123",
    });
  });

  it("rejects unsafe schemes and extra request fields", () => {
    expect(
      ensureProjectWebsiteRequestSchema.safeParse({ website: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(
      ensureProjectWebsiteRequestSchema.safeParse({ website: "example.com", admin: true }).success,
    ).toBe(false);
    expect(
      ensureProjectWebsiteRequestSchema.safeParse({
        website: "example.com",
        websiteId: "website id with spaces",
      }).success,
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

  it("lists only safe Website setup state without recorder secrets", () => {
    const parsed = projectWebsitesResponseSchema.parse({
      websites: [
        {
          id: "website_1",
          name: "example.com",
          origin: "https://example.com",
          firstEventAt: null,
        },
      ],
    });

    expect(parsed).toEqual({
      websites: [
        {
          id: "website_1",
          name: "example.com",
          origin: "https://example.com",
          firstEventAt: null,
        },
      ],
    });
    expect(
      projectWebsitesResponseSchema.safeParse({
        websites: [
          { id: "website_1", name: "example.com", origin: "not a URL", firstEventAt: null },
        ],
      }).success,
    ).toBe(false);
  });
});
