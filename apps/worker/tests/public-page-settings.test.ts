import { describe, expect, it } from "vite-plus/test";
import { readPublicPageOrigin } from "../src/api/public-page-settings.ts";
import type { Env } from "../src/env.ts";

describe("public page origin", () => {
  it("requires HTTPS in production", async () => {
    const result = readPublicPageOrigin(new URL("https://worker.example.com"), {
      WORKER_ENV: "production",
      PUBLIC_PAGE_ORIGIN: "http://public.example.com",
    } as Env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    expect(await result.response.json()).toEqual({ error: "public_page_origin_invalid" });
  });

  it("rejects a non-standard production port", () => {
    expect(
      readPublicPageOrigin(new URL("https://worker.example.com"), {
        WORKER_ENV: "production",
        PUBLIC_PAGE_ORIGIN: "https://public.example.com:8443",
      } as Env).ok,
    ).toBe(false);
  });

  it("allows a plain local HTTP origin but rejects paths", () => {
    expect(
      readPublicPageOrigin(new URL("http://localhost:8787"), {
        WORKER_ENV: "development",
        PUBLIC_PAGE_ORIGIN: "http://localhost:8787",
      } as Env),
    ).toEqual({ ok: true, origin: "http://localhost:8787" });

    expect(
      readPublicPageOrigin(new URL("http://localhost:8787"), {
        WORKER_ENV: "development",
        PUBLIC_PAGE_ORIGIN: "http://localhost:8787/private",
      } as Env).ok,
    ).toBe(false);
  });
});
