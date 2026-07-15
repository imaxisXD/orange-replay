import {
  authConfigResponseSchema,
  listSessionsResponseSchema,
  liveSessionsResponseSchema,
  projectStatsResponseSchema,
  sessionManifestSchema,
} from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  authHeaders,
  demoManifestJson,
  demoOtherProjectId,
  demoProjectId,
  demoSessionId,
  demoWriteKey,
  listProjectId,
  segmentBytes,
  segmentName,
  setupApiTestWorkers,
  worker,
  workerWithDemo,
  workerWithoutAuth,
} from "./api-test-helpers.ts";

setupApiTestWorkers({ withoutAuth: true, demo: true });

describe("dashboard api", () => {
  it("serves health without auth", async () => {
    const res = await worker.fetch("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports whether Better Auth is ready", async () => {
    const configured = await worker.fetch("/api/v1/auth/config");
    expect(configured.status).toBe(200);
    expect(configured.headers.get("cache-control")).toBe("no-store");
    expect(authConfigResponseSchema.parse(await configured.json())).toEqual({ mode: "github" });

    const missing = await workerWithoutAuth.fetch("/api/v1/auth/config");
    expect(missing.status).toBe(200);
    expect(authConfigResponseSchema.parse(await missing.json())).toEqual({ mode: "unavailable" });
  });

  it("routes Better Auth before project authorization", async () => {
    const res = await workerWithoutAuth.fetch("/api/auth/get-session");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "hosted_auth_not_enabled" });
  });

  it("fails closed when Better Auth is not configured", async () => {
    const health = await workerWithoutAuth.fetch("/api/v1/health");
    expect(health.status).toBe(200);

    const res = await workerWithoutAuth.fetch(`/api/v1/projects/${listProjectId}/sessions`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "auth_not_configured" });
  });

  it("rejects missing sessions and unsupported authorization headers", async () => {
    const missing = await worker.fetch(`/api/v1/projects/${listProjectId}/sessions`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const wrong = await worker.fetch(`/api/v1/projects/${listProjectId}/sessions`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });
  });

  it("keeps demo disabled when demo env is unset", async () => {
    const discovery = await worker.fetch("/api/v1/demo");
    expect(discovery.status).toBe(404);
    expect(await discovery.json()).toEqual({ error: "not_found" });

    const missing = await worker.fetch(`/api/v1/projects/${demoProjectId}/sessions`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });
  });

  it("serves demo discovery when demo env is set", async () => {
    const res = await workerWithDemo.fetch("/api/v1/demo");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await res.json()).toEqual({
      projectId: demoProjectId,
      writeKey: demoWriteKey,
    });
  });

  it("allows only demo-readable routes without an account session", async () => {
    const sessions = await workerWithDemo.fetch(
      `/api/v1/projects/${demoProjectId}/sessions?limit=1`,
    );
    expect(sessions.status).toBe(200);
    expect(listSessionsResponseSchema.parse(await sessions.json()).sessions).toHaveLength(1);

    const live = await workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/live`);
    expect(live.status).toBe(200);
    expect(liveSessionsResponseSchema.parse(await live.json())).toEqual({
      truncated: false,
      sessions: [
        {
          session_id: "api_demo_live",
          started_at: expect.any(Number),
          last_seen: expect.any(Number),
          entry_url: "/demo-live",
          country: "US",
          city: "Austin",
          browser: "Chrome",
          os: "macOS",
          device: "desktop",
          duration_ms: expect.any(Number),
        },
      ],
    });

    const stats = await workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/stats`);
    expect(stats.status).toBe(200);
    expect(projectStatsResponseSchema.parse(await stats.json()).sessions.value).toBe(61);

    const manifest = await workerWithDemo.fetch(
      `/api/v1/projects/${demoProjectId}/sessions/${demoSessionId}/manifest`,
    );
    expect(manifest.status).toBe(200);
    const manifestText = await manifest.text();
    expect(manifestText).toBe(demoManifestJson);
    expect(() => sessionManifestSchema.parse(JSON.parse(manifestText))).not.toThrow();

    const segment = await workerWithDemo.fetch(
      `/api/v1/projects/${demoProjectId}/sessions/${demoSessionId}/segments/${segmentName}`,
    );
    expect(segment.status).toBe(200);
    expect(Array.from(new Uint8Array(await segment.arrayBuffer()))).toEqual(
      Array.from(segmentBytes),
    );

    const ticket = await workerWithDemo.fetch(
      `/api/v1/projects/${demoProjectId}/sessions/${demoSessionId}/live-ticket`,
      { method: "POST" },
    );
    expect(ticket.status).toBe(200);
    expect(await ticket.json()).toEqual({
      ticket: expect.any(String),
      expiresAt: expect.any(Number),
    });
  });

  it("rejects demo context on non-demo-readable routes", async () => {
    const denied = [
      workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/config`),
      workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/config`, {
        method: "PUT",
        body: JSON.stringify({ sampleRate: 1 }),
      }),
      workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/keys`),
      workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/install-status`),
      workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/unknown`),
    ];

    for (const response of await Promise.all(denied)) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("does not let headers, query params, or bodies enable demo for another project", async () => {
    const headerAndQuery = await workerWithDemo.fetch(
      `/api/v1/projects/${demoOtherProjectId}/sessions?demoProjectId=${demoProjectId}`,
      { headers: { "x-demo-project-id": demoProjectId } },
    );
    expect(headerAndQuery.status).toBe(401);
    expect(await headerAndQuery.json()).toEqual({ error: "unauthorized" });

    const body = await workerWithDemo.fetch(`/api/v1/projects/${demoOtherProjectId}/config`, {
      method: "PUT",
      body: JSON.stringify({ demoProjectId }),
    });
    expect(body.status).toBe(401);
    expect(await body.json()).toEqual({ error: "unauthorized" });
  });

  it("does not fall back to demo when an authorization header is present", async () => {
    const res = await workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/sessions`, {
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("clamps demo session list limits to fifty", async () => {
    const res = await workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/sessions?limit=100`);

    expect(res.status).toBe(200);
    expect(listSessionsResponseSchema.parse(await res.json()).sessions).toHaveLength(50);
  });

  it("rejects signed-in users outside their project membership", async () => {
    const forbidden = await worker.fetch("/api/v1/projects/other_project/sessions", {
      headers: authHeaders(),
    });

    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
  });

  it("rejects missing sessions and authorization headers for private routes", async () => {
    const paths = [
      `/api/v1/projects/${listProjectId}/stats`,
      `/api/v1/projects/${listProjectId}/live`,
      `/api/v1/projects/${listProjectId}/config`,
      `/api/v1/projects/${listProjectId}/install-status`,
      `/api/v1/projects/${listProjectId}/keys`,
    ];

    for (const path of paths) {
      const missing = await worker.fetch(path);
      expect(missing.status).toBe(401);

      const wrong = await worker.fetch(path, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(wrong.status).toBe(401);
    }
  });
});
