import { describe, expect, it } from "vite-plus/test";
import {
  FAVICON_API_VERSION,
  WEBSITE_URL_ISSUE,
  websiteAllowedOrigins,
  websiteNameFromUrl,
  websiteUrlSchema,
} from "../src/website-url.ts";

describe("website URL schema", () => {
  it("keeps a shared favicon API version for browser and edge cache busting", () => {
    expect(FAVICON_API_VERSION).toBe("3");
  });

  it("defaults normal website input to HTTPS", () => {
    expect(websiteUrlSchema.safeParse("acme.com").data?.href).toBe("https://acme.com/");
    expect(websiteUrlSchema.safeParse("  acme.com/pricing  ").data?.href).toBe(
      "https://acme.com/pricing",
    );
    expect(websiteUrlSchema.safeParse("www.acme.app/pricing").data?.href).toBe(
      "https://www.acme.app/pricing",
    );
    expect(websiteUrlSchema.safeParse("//acme.com").data?.origin).toBe("https://acme.com");
    expect(websiteUrlSchema.safeParse("acme.com:8080").data?.origin).toBe("https://acme.com:8080");
  });

  it("keeps an explicit HTTP or HTTPS address", () => {
    expect(websiteUrlSchema.safeParse("http://localhost:3000").data?.origin).toBe(
      "http://localhost:3000",
    );
    expect(websiteUrlSchema.safeParse("https://shop.acme.co.uk/path").data?.pathname).toBe("/path");
  });

  it("rejects unsafe schemes, credentials, spaces, and incomplete hosts", () => {
    expect(websiteUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(websiteUrlSchema.safeParse("https://user:pass@acme.com").success).toBe(false);
    expect(websiteUrlSchema.safeParse("acme com").success).toBe(false);
    expect(websiteUrlSchema.safeParse("acme").success).toBe(false);
  });

  it("keeps the long project-name reason distinct", () => {
    const boundaryHost = `${"a".repeat(48)}.${"b".repeat(47)}.com`;
    expect(boundaryHost).toHaveLength(100);
    expect(websiteUrlSchema.safeParse(boundaryHost).success).toBe(true);

    const result = websiteUrlSchema.safeParse(`https://${"a".repeat(50)}.${"b".repeat(50)}.com`);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(WEBSITE_URL_ISSUE.projectNameTooLong);
    }
  });

  it("rejects empty and overlong input", () => {
    expect(websiteUrlSchema.safeParse("").success).toBe(false);
    expect(websiteUrlSchema.safeParse(`acme.com/${"a".repeat(2_048)}`).success).toBe(false);
  });

  it("uses the bare hostname as the website name", () => {
    expect(websiteNameFromUrl(new URL("https://www.acme.com/path"))).toBe("acme.com");
  });

  it("builds the exact Website origin boundary and its common www alias", () => {
    expect(websiteAllowedOrigins(new URL("https://example.com/path"))).toEqual([
      "https://example.com",
      "https://www.example.com",
    ]);
    expect(websiteAllowedOrigins(new URL("https://www.example.com/path"))).toEqual([
      "https://www.example.com",
      "https://example.com",
    ]);
    expect(websiteAllowedOrigins(new URL("http://localhost:3000"))).toEqual([
      "http://localhost:3000",
    ]);
  });
});
