import { startWideEvent } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import type { Env } from "../src/env.ts";
import { getPublicPageSettings, putPublicPageSettings } from "../src/api/public-page-settings.ts";
import { resolvePublicPageOrigin } from "../src/public-page/publication.ts";

describe("public page origin", () => {
  it("requires HTTPS in production", async () => {
    const result = resolvePublicPageOrigin(new URL("https://worker.example.com"), {
      WORKER_ENV: "production",
      PUBLIC_PAGE_ORIGIN: "http://public.example.com",
    } as Env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("public_page_origin_invalid");
  });

  it("rejects a non-standard production port", () => {
    expect(
      resolvePublicPageOrigin(new URL("https://worker.example.com"), {
        WORKER_ENV: "production",
        PUBLIC_PAGE_ORIGIN: "https://public.example.com:8443",
      } as Env).ok,
    ).toBe(false);
  });

  it("allows a plain local HTTP origin but rejects paths", () => {
    expect(
      resolvePublicPageOrigin(new URL("http://localhost:8787"), {
        WORKER_ENV: "development",
        PUBLIC_PAGE_ORIGIN: "http://localhost:8787",
      } as Env),
    ).toEqual({ ok: true, origin: "http://localhost:8787" });

    expect(
      resolvePublicPageOrigin(new URL("http://localhost:8787"), {
        WORKER_ENV: "development",
        PUBLIC_PAGE_ORIGIN: "http://localhost:8787/private",
      } as Env).ok,
    ).toBe(false);
  });
});

describe("public page settings error contract", () => {
  it("returns not found before checking the public origin", async () => {
    const env = productionEnv(projectDatabase(false));
    const requestUrl = new URL("https://worker.example.com/api/v1/projects/missing/public-page");

    const getResponse = await getPublicPageSettings(requestUrl, env, "missing");
    expect(getResponse.status).toBe(404);
    await expect(getResponse.json()).resolves.toEqual({ error: "not_found" });

    const putResponse = await putPublicPageSettings(
      settingsRequest(requestUrl),
      requestUrl,
      env,
      "missing",
      startWideEvent("test", "public_page_settings"),
    );
    expect(putResponse.status).toBe(404);
    await expect(putResponse.json()).resolves.toEqual({ error: "not_found" });
  });

  it("maps production origin configuration errors to service unavailable", async () => {
    const requestUrl = new URL("https://worker.example.com/api/v1/projects/project-1/public-page");
    const missingOriginEnv = productionEnv(projectDatabase(true));
    const invalidOriginEnv = {
      ...productionEnv(projectDatabase(true)),
      PUBLIC_PAGE_ORIGIN: "http://public.example.com",
    } as Env;

    const getResponse = await getPublicPageSettings(requestUrl, missingOriginEnv, "project-1");
    expect(getResponse.status).toBe(503);
    await expect(getResponse.json()).resolves.toEqual({ error: "public_page_origin_not_set" });

    const putResponse = await putPublicPageSettings(
      settingsRequest(requestUrl),
      requestUrl,
      invalidOriginEnv,
      "project-1",
      startWideEvent("test", "public_page_settings"),
    );
    expect(putResponse.status).toBe(503);
    await expect(putResponse.json()).resolves.toEqual({ error: "public_page_origin_invalid" });
  });
});

function productionEnv(database: Env["IDX_00"]): Env {
  return {
    IDX_00: database,
    WORKER_ENV: "production",
  } as Env;
}

function projectDatabase(projectExists: boolean): Env["IDX_00"] {
  type PreparedStatement = ReturnType<Env["IDX_00"]["prepare"]>;
  function bind(): PreparedStatement {
    return statement;
  }
  const statement = {
    bind,
    first: async () => (projectExists ? { exists: 1 } : null),
  } as unknown as PreparedStatement;
  return {
    prepare(): PreparedStatement {
      return statement;
    },
  } as unknown as Env["IDX_00"];
}

function settingsRequest(url: URL): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false, expectedRevision: 0, sessionIds: [] }),
  });
}
