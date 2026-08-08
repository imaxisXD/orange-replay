import { describe, expect, it, vi } from "vite-plus/test";
import { createSdkHealthReporter } from "../src/health.ts";

describe("SDK health reporter", () => {
  it("sends only one fixed, privacy-safe report", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const reporter = createSdkHealthReporter(
      {
        key: "or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ingestUrl: "https://ingest.test",
      },
      fetchMock,
    );

    reporter("config_failed");
    reporter("pipeline_stopped");
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ingest.test/v1/sdk-health",
      expect.objectContaining({
        method: "POST",
        body: '{"version":1,"code":"config_failed"}',
        credentials: "omit",
        keepalive: true,
      }),
    );
  });

  it("never throws when the browser blocks the health request", () => {
    const reporter = createSdkHealthReporter(
      { key: "or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ingestUrl: "https://ingest.test" },
      (() => {
        throw new Error("blocked");
      }) as typeof fetch,
    );

    expect(() => reporter("worker_blocked")).not.toThrow();
  });
});
