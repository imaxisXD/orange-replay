import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

describe("replay asset download deadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cancels and unlocks a stalled asset body after its headers arrive", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel,
    });
    const result = fetchPublicReplayAsset("https://cdn.customer.com/a.css", {
      fetchFn: async () => new Response(body, { headers: { "content-type": "text/css" } }),
      resolveHost: async () => ["1.1.1.1"],
      timeoutMs: 20,
    }).catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      await expect(result).resolves.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (body.locked) bodyController?.close();
      await result;
    }
  });

  it("cancels stalled DNS response bodies within the same download deadline", async () => {
    const bodies: ReadableStream<Uint8Array>[] = [];
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const cancel = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
        },
        cancel,
      });
      bodies.push(body);
      return new Response(body, { headers: { "content-type": "application/dns-json" } });
    });
    const result = fetchPublicReplayAsset("https://cdn.customer.com/a.css", {
      fetchFn: fetchMock,
      timeoutMs: 20,
    }).catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(bodies.every((body) => !body.locked)).toBe(true);
      await expect(result).resolves.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      bodies.forEach((body, index) => {
        if (body.locked) controllers[index]?.close();
      });
      await result;
    }
  });

  it("uses one deadline across DNS checks and redirects", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel,
    });
    const resolveHost = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return ["1.1.1.1"];
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/start.css") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(null, { status: 302, headers: { location: "/final.css" } });
      }
      return new Response(body, { headers: { "content-type": "text/css" } });
    });
    const result = fetchPublicReplayAsset("https://cdn.customer.com/start.css", {
      fetchFn: fetchMock,
      resolveHost,
      timeoutMs: 100,
    }).catch((error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(99);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(resolveHost).toHaveBeenCalledTimes(2);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(cancel).toHaveBeenCalledOnce();
      await expect(result).resolves.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (body.locked) bodyController?.close();
      await result;
    }
  });

  it("finishes public DNS validation and a safe redirect without leaving a timer or locked body", async () => {
    const bodies: ReadableStream<Uint8Array>[] = [];
    const redirectCancelled = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "cloudflare-dns.com") {
        const response = Response.json({ Answer: [{ data: "1.1.1.1" }] });
        if (response.body !== null) bodies.push(response.body);
        return response;
      }
      if (url.pathname === "/start.css") {
        const body = new ReadableStream<Uint8Array>({ cancel: redirectCancelled });
        bodies.push(body);
        return new Response(body, {
          status: 302,
          headers: { location: "https://assets.customer.com/final.css" },
        });
      }
      const response = new Response("body { color: black; }", {
        headers: { "content-type": "text/css" },
      });
      if (response.body !== null) bodies.push(response.body);
      return response;
    });

    const result = await fetchPublicReplayAsset("https://cdn.customer.com/start.css", {
      fetchFn: fetchMock,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      kind: "stylesheet",
      finalUrl: "https://assets.customer.com/final.css",
    });
    expect(new TextDecoder().decode(result?.bytes)).toBe("body { color: black; }");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(redirectCancelled).toHaveBeenCalledOnce();
    expect(bodies.every((body) => !body.locked)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled custom DNS resolver without starting an asset request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = fetchPublicReplayAsset("https://cdn.customer.com/a.css", {
      fetchFn: fetchMock,
      resolveHost: async () => await new Promise<readonly string[]>(() => {}),
      timeoutMs: 20,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let stalled stream cancellation extend the deadline", async () => {
    const cancel = vi.fn(async () => await new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const result = fetchPublicReplayAsset("https://cdn.customer.com/a.css", {
      fetchFn: async () => new Response(body, { headers: { "content-type": "text/css" } }),
      resolveHost: async () => ["1.1.1.1"],
      timeoutMs: 20,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { status: 404, contentType: "text/css" },
    { status: 200, contentType: "text/html" },
  ])(
    "cancels a rejected response body for $status and $contentType",
    async ({ status, contentType }) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });

      await expect(
        fetchPublicReplayAsset("https://cdn.customer.com/a.css", {
          fetchFn: async () =>
            new Response(body, { status, headers: { "content-type": contentType } }),
          resolveHost: async () => ["1.1.1.1"],
        }),
      ).resolves.toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a rejected response whose stream cancellation never finishes", async () => {
    const cancel = vi.fn(async () => await new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const result = fetchPublicReplayAsset("https://cdn.customer.com/a.css", {
      fetchFn: async () => new Response(body, { status: 404 }),
      resolveHost: async () => ["1.1.1.1"],
      timeoutMs: 20,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the other DNS lookup when an address lookup fails", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.searchParams.get("type") === "A"
        ? new Response(null, { status: 503 })
        : new Response(body, { headers: { "content-type": "application/dns-json" } });
    });

    await expect(
      fetchPublicReplayAsset("https://cdn.customer.com/a.css", { fetchFn: fetchMock }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still cancels an oversized streamed asset and releases its reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });

    await expect(
      fetchPublicReplayAsset("https://cdn.customer.com/a.css", {
        fetchFn: async () => new Response(body, { headers: { "content-type": "text/css" } }),
        resolveHost: async () => ["1.1.1.1"],
      }),
    ).rejects.toMatchObject({
      name: "ReplayAssetRejectedError",
      message: expect.stringContaining("too large"),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
