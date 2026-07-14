import type { PublicPageData } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import { escapeJsonForHtml } from "../src/document.tsx";
import { makePublicPageQueryClient } from "../src/query.ts";
import { renderPublicPage } from "../src/server.tsx";

describe("public page server rendering", () => {
  it("uses a new query client for every server request", () => {
    expect(makePublicPageQueryClient()).not.toBe(makePublicPageQueryClient());
  });

  it("renders real page data and escapes the hydration payload", async () => {
    const stream = await renderPublicPage(pageData('</script><script>alert("unsafe")</script>'));
    const html = await new Response(stream).text();

    expect(html).toContain("Public analytics");
    expect(html).toContain("Sessions");
    expect(html).toContain("42");
    expect(html).toContain('rel="canonical"');
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).not.toContain('<script>alert("unsafe")</script>');
  });

  it("escapes every character that can leave a JSON script element", () => {
    expect(escapeJsonForHtml("<&>\u2028\u2029")).toBe("\\u003c\\u0026\\u003e\\u2028\\u2029");
  });
});

function pageData(projectName: string): PublicPageData {
  return {
    version: 1,
    publicId: "pub_test",
    publicUrl: "https://public.example.com/p/pub_test",
    projectName,
    generatedAt: 1,
    analytics: {
      sessions: 42,
      averageDurationMs: 15_000,
      p50DurationMs: 10_000,
      clicks: 100,
      pagesPerSession: 2.5,
      pagesCoveredSessions: 40,
      ragePercent: 0.1,
      quickBackPercent: 0.2,
      countries: [{ label: "US", count: 20, share: 0.5 }],
      devices: [],
      browsers: [],
      operatingSystems: [],
      entryPages: [],
    },
    recordings: [],
  };
}
