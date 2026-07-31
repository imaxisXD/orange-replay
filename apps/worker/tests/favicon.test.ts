import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { startWideEvent } from "@orange-replay/shared";
import { getFavicon } from "../src/api/favicon.ts";
import type { Env } from "../src/env.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MULTI_SIZE_ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x03, 0x00, 0x30, 0x30]);
const waitUntil = vi.fn();
const context = { waitUntil } as unknown as Parameters<typeof getFavicon>[2];

beforeEach(() => {
  waitUntil.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("favicon API", () => {
  it("chooses the largest declared icon and returns validated image bytes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          '<html><head><link rel="icon" sizes="16x16" href="/small.png"><link rel="apple-touch-icon" sizes="180x180" href="/large.png"></head></html>',
          { headers: { "content-type": "text/html" } },
        ),
      )
      .mockResolvedValueOnce(new Response(PNG, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestFavicon("acme.com");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("max-age=604800");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://acme.com/large.png"),
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("accepts a multi-size Windows icon declared by a Next.js site", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          '<link rel="icon" href="/favicon.ico?favicon.site.ico" sizes="48x48" type="image/x-icon">',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(MULTI_SIZE_ICO, {
          headers: { "content-type": "image/vnd.microsoft.icon" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestFavicon("ndle.app");

    expect(response.headers.get("content-type")).toBe("image/vnd.microsoft.icon");
    expect(response.headers.get("x-favicon-result")).toBe("fetched");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://ndle.app/favicon.ico?favicon.site.ico"),
      expect.objectContaining({ headers: expect.objectContaining({ accept: "image/*" }) }),
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MULTI_SIZE_ICO);
  });

  it("returns a deterministic uncached image fallback when a site has no usable icon", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(undefined), put } });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("<html></html>"))
        .mockResolvedValueOnce(new Response("not an icon", { status: 404 })),
    );

    const response = await requestFavicon("no-icon-site.com");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-favicon-result")).toBe("not_found");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain(">N</text>");
    expect(put).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("rejects a fake image and continues to the safe fallback", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<link rel="icon" href="/fake.png">'))
      .mockResolvedValueOnce(
        new Response("<svg></svg>", { headers: { "content-type": "image/png" } }),
      )
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestFavicon("acme.com");

    expect(response.headers.get("x-favicon-result")).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not follow a website redirect to a private address", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
      )
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestFavicon("acme.com");

    expect(response.headers.get("x-favicon-result")).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => new URL(url).hostname === "127.0.0.1")).toBe(false);
  });

  it("rejects an image that declares more than the byte limit", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<link rel="icon" href="/large.png">'))
      .mockResolvedValueOnce(
        new Response(PNG, {
          headers: { "content-length": String(512 * 1_024 + 1), "content-type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestFavicon("acme.com");

    expect(response.headers.get("x-favicon-result")).toBe("not_found");
  });

  it("still tries favicon.ico after the declared-icon attempt limit", async () => {
    const declaredIcons = Array.from(
      { length: 9 },
      (_, index) => `<link rel="icon" href="/bad-${index}.png">`,
    ).join("");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(declaredIcons));
    for (let index = 0; index < 8; index += 1) {
      fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    }
    fetchMock.mockResolvedValueOnce(
      new Response(PNG, { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestFavicon("acme.com");

    expect(response.headers.get("x-favicon-result")).toBe("fetched");
    expect(fetchMock).toHaveBeenLastCalledWith(
      new URL("https://acme.com/favicon.ico"),
      expect.any(Object),
    );
  });

  it("never fetches local or private targets", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestFavicon("http://127.0.0.1:8787");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-favicon-result")).toBe("unsafe_target");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate limits only work that missed the edge cache", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const response = await requestFavicon("acme.com", {
      FAVICON_RATE_LIMITER: { limit },
    } as unknown as Env);

    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "user:user_1" });
  });

  it("serves an edge-cache hit without spending a rate-limit token", async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const match = vi.fn().mockResolvedValue(
      new Response(PNG, {
        headers: { "content-type": "image/png", "x-favicon-result": "fetched" },
      }),
    );
    vi.stubGlobal("caches", { default: { match, put: vi.fn() } });

    const response = await requestFavicon("acme.com", {
      FAVICON_RATE_LIMITER: { limit },
    } as unknown as Env);

    expect(response.status).toBe(200);
    expect(match).toHaveBeenCalledOnce();
    expect(limit).not.toHaveBeenCalled();
  });

  it("stores a normalized cache-miss result in the edge cache", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(undefined), put } });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('<link rel="icon" href="/icon.png">'))
        .mockResolvedValueOnce(new Response(PNG, { headers: { "content-type": "image/png" } })),
    );

    await requestFavicon("https://www.acme.com/path?q=one");

    expect(put).toHaveBeenCalledOnce();
    const cacheCall = put.mock.calls.at(0);
    if (cacheCall === undefined) throw new Error("Expected the favicon to be cached.");
    expect((cacheCall[0] as Request).url).toBe(
      "https://replay.example/api/v1/favicon?website=https%3A%2F%2Fwww.acme.com&v=3",
    );
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("fails closed when the rate limiter is unavailable", async () => {
    const limit = vi.fn().mockRejectedValue(new Error("binding unavailable"));
    const response = await requestFavicon("acme.com", {
      FAVICON_RATE_LIMITER: { limit },
    } as unknown as Env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "favicon_unavailable" });
  });

  it("fails closed when the rate-limit binding is missing", async () => {
    const response = await requestFavicon("acme.com", {} as Env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "favicon_unavailable" });
  });

  it("rejects malformed website input", async () => {
    const response = await requestFavicon("javascript:alert(1)");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_website" });
  });
});

function requestFavicon(
  website: string,
  env = {
    FAVICON_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  } as unknown as Env,
): Promise<Response> {
  return getFavicon(
    new Request(`https://replay.example/api/v1/favicon?website=${encodeURIComponent(website)}`),
    env,
    context,
    "user_1",
    startWideEvent("worker", "favicon.test", "request_1"),
  );
}
