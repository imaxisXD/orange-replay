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
