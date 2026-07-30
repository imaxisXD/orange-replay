import { describe, expect, it } from "vite-plus/test";
import { isDashboardAppRoute, serveDashboardAppShell } from "../src/app-shell.ts";
import type { Env } from "../src/env.ts";

describe("dashboard app shell routing", () => {
  it("serves the dashboard app shell for login and project routes", async () => {
    const assetPaths: string[] = [];
    const env = envWithAssets(assetPaths);

    const login = await serveDashboardAppShell(
      new Request("https://replay.test/login?reason=unauthorized"),
      env,
      "/login",
    );
    const project = await serveDashboardAppShell(
      new Request("https://replay.test/projects/p1/sessions"),
      env,
      "/projects/p1/sessions",
    );
    const demo = await serveDashboardAppShell(
      new Request("https://replay.test/demo/sessions"),
      env,
      "/demo/sessions",
    );

    expect(login.status).toBe(200);
    expect(project.status).toBe(200);
    expect(demo.status).toBe(200);
    expect(await login.text()).toContain("Orange Replay Dashboard");
    expect(await project.text()).toContain("Orange Replay Dashboard");
    expect(await demo.text()).toContain("Orange Replay Dashboard");
    expect(assetPaths).toEqual([
      "/dashboard/index.html",
      "/dashboard/index.html",
      "/dashboard/index.html",
    ]);
  });

  it("does not turn the root route into the dashboard shell", async () => {
    expect(isDashboardAppRoute("/")).toBe(false);
  });

  it("serves the shell for every client-routed dashboard path", () => {
    // Activation is where new accounts land, so a missing entry here means the
    // first URL a customer ever sees 404s the moment they refresh or share it.
    for (const pathname of [
      "/login",
      "/_admin",
      "/_admin/users",
      "/demo",
      "/demo/sessions",
      "/projects",
      "/projects/p1/overview",
      "/onboarding",
      "/onboarding/website",
      "/onboarding/install",
      "/onboarding/verify",
    ]) {
      expect(isDashboardAppRoute(pathname), pathname).toBe(true);
    }
  });

  it("keeps the shell away from api, ingest and public page paths", () => {
    for (const pathname of ["/api/v1/health", "/internal/x", "/v1/e", "/p/abc", "/onboardingx"]) {
      expect(isDashboardAppRoute(pathname), pathname).toBe(false);
    }
  });
});

function envWithAssets(assetPaths: string[]): Env {
  return {
    ASSETS: {
      async fetch(request: Request | string): Promise<Response> {
        const url = new URL(typeof request === "string" ? request : request.url);
        assetPaths.push(url.pathname + url.search);
        return new Response("<!doctype html><title>Orange Replay Dashboard</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  } as Env;
}
