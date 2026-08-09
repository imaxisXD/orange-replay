import { describe, expect, it, vi } from "vite-plus/test";
import {
  fetchPublicReplayAsset,
  hostnameResolvesPublicly,
  safePublicAssetUrl,
} from "../src/replay-assets/security.ts";

describe("replay asset network boundary", () => {
  it.each([
    "http://127.0.0.1/a.png",
    "http://10.0.0.1/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/a.png",
    "https://user:secret@example.com/a.png",
    "https://example.com:8443/a.png",
    "https://cdn.example.com/a.png?token=secret",
    "https://cdn.example.com/a.png?X-Amz-Signature=secret",
    "https://192.0.2.1/a.png",
    "https://198.51.100.1/a.png",
    "https://203.0.113.1/a.png",
    "https://cdn.example/a.png",
    "https://orange-replay.workers.dev/internal",
    "file:///etc/passwd",
  ])("rejects a private or unsafe URL: %s", (url) => {
    expect(safePublicAssetUrl(url)).toBeNull();
  });

  it("blocks Orange Replay service hosts and permits an ordinary public asset URL", () => {
    expect(
      safePublicAssetUrl("https://api.orange.test/a.png", undefined, ["orange.test"]),
    ).toBeNull();
    expect(safePublicAssetUrl("https://cdn.customer.com/a.png")?.toString()).toBe(
      "https://cdn.customer.com/a.png",
    );
  });

  it("accepts only hostnames whose complete DNS answer is public", async () => {
    await expect(hostnameResolvesPublicly("cdn.test", async () => ["1.1.1.1"])).resolves.toBe(true);
    await expect(
      hostnameResolvesPublicly("cdn.test", async () => ["1.1.1.1", "10.0.0.4"]),
    ).resolves.toBe(false);
    await expect(hostnameResolvesPublicly("cdn.test", async () => [])).resolves.toBe(false);
  });

  it("fetches a bounded public image without forwarding credentials", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]);
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(png, { headers: { "content-type": "image/png" } }),
    );

    const result = await fetchPublicReplayAsset("https://cdn.customer.com/a.png", {
      fetchFn: fetchMock,
      resolveHost: async () => ["1.1.1.1"],
    });

    expect(result).toMatchObject({ kind: "image", contentType: "image/png" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://cdn.customer.com/a.png"),
      expect.objectContaining({ redirect: "manual", cache: "no-store" }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("user-agent")).toContain("Orange-Replay-Assets");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  });

  it("revalidates redirects and refuses a redirect to a private address", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.png" } }),
    );

    const result = await fetchPublicReplayAsset("https://cdn.customer.com/a.png", {
      fetchFn: fetchMock,
      resolveHost: async () => ["1.1.1.1"],
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops reading an asset that declares more than the hard limit", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          headers: { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) },
        }),
    );

    await expect(
      fetchPublicReplayAsset("https://cdn.customer.com/a.png", {
        fetchFn: fetchMock,
        resolveHost: async () => ["1.1.1.1"],
      }),
    ).rejects.toThrow("too large");
  });

  it("aborts a public asset request after the timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    await expect(
      fetchPublicReplayAsset("https://cdn.customer.com/a.png", {
        fetchFn: fetchMock,
        resolveHost: async () => ["1.1.1.1"],
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
