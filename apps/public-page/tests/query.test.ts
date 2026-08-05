import type { PublicPageData } from "@orange-replay/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makePublicPageQueryClient, publicPageQueryOptions } from "../src/query.ts";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("public page query", () => {
  it("returns a validated page response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(publicPageData()));

    await expect(
      makePublicPageQueryClient().fetchQuery(publicPageQueryOptions("pub_test")),
    ).resolves.toEqual(publicPageData());
  });

  it("rejects incomplete data and a mismatched public id", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ version: 1, publicId: "pub_test" }))
      .mockResolvedValueOnce(jsonResponse({ version: 1, publicId: "pub_test" }));
    await expect(
      makePublicPageQueryClient().fetchQuery(publicPageQueryOptions("pub_test")),
    ).rejects.toThrow("This public page is temporarily unavailable");

    fetchMock.mockResolvedValue(jsonResponse({ ...publicPageData(), publicId: "pub_other" }));
    await expect(
      makePublicPageQueryClient().fetchQuery(publicPageQueryOptions("pub_test")),
    ).rejects.toThrow("This public page is temporarily unavailable");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function publicPageData(): PublicPageData {
  return {
    version: 1,
    publicId: "pub_test",
    publicUrl: "https://public.example.com/p/pub_test",
    projectName: "Orange Replay",
    generatedAt: 1,
    analytics: {
      sessions: 1,
      averageDurationMs: 1_500,
      p50DurationMs: 1_000,
      clicks: 2,
      pagesPerSession: 1.5,
      pagesCoveredSessions: 1,
      ragePercent: 0.1,
      quickBackPercent: null,
      countries: [],
      devices: [],
      browsers: [],
      operatingSystems: [],
      entryPages: [],
    },
    recordings: [],
  };
}
