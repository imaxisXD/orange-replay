import { describe, expect, it } from "vite-plus/test";
import {
  nextWorkspaceCookieDomain,
  workspaceJourneyDomain,
} from "../src/api/project-website-domain.ts";

describe("Workspace Website cookie domain", () => {
  it("shares a journey when sibling subdomains are added first", () => {
    const first = nextWorkspaceCookieDomain(undefined, new URL("https://app.example.com"));
    expect(first).toBe("example.com");
    expect(
      nextWorkspaceCookieDomain(first ?? undefined, new URL("https://checkout.example.com")),
    ).toBe("example.com");
  });

  it("handles multi-part and private public suffixes safely", () => {
    expect(nextWorkspaceCookieDomain(undefined, new URL("https://app.example.co.uk"))).toBe(
      "example.co.uk",
    );
    expect(nextWorkspaceCookieDomain(undefined, new URL("https://app.noodle.github.io"))).toBe(
      "noodle.github.io",
    );
  });

  it("normalizes the stored domain before the dashboard uses it", () => {
    expect(workspaceJourneyDomain(".app.example.co.uk.")).toBe("example.co.uk");
    expect(workspaceJourneyDomain("app.noodle.github.io")).toBe("noodle.github.io");
    expect(workspaceJourneyDomain(undefined)).toBeNull();
  });

  it("keeps unrelated root domains isolated", () => {
    expect(
      nextWorkspaceCookieDomain("example.com", new URL("https://dashboard.other-app.com")),
    ).toBe("example.com");
  });

  it("uses host-only cookies for local, IP, and insecure Websites", () => {
    expect(nextWorkspaceCookieDomain(undefined, new URL("http://example.com"))).toBeNull();
    expect(nextWorkspaceCookieDomain(undefined, new URL("https://localhost:3000"))).toBeNull();
    expect(nextWorkspaceCookieDomain(undefined, new URL("https://127.0.0.1"))).toBeNull();
  });

  it("widens an older subdomain value when the safe root becomes known", () => {
    expect(
      nextWorkspaceCookieDomain("app.example.com", new URL("https://checkout.example.com")),
    ).toBe("example.com");
  });
});
