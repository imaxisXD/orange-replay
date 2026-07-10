import { describe, expect, it } from "vite-plus/test";
import type { ProjectStats } from "../src/api/stats.ts";
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
  type SessionsResponse,
  worker,
  workerWithDemo,
  workerWithoutToken,
} from "./api-test-helpers.ts";

setupApiTestWorkers({ withoutToken: true, demo: true });

describe("dashboard api", () => {
  it("serves health without auth", async () => {
    const res = await worker.fetch("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("fails closed when the dev token is not configured", async () => {
    const health = await workerWithoutToken.fetch("/api/v1/health");
    expect(health.status).toBe(200);

    const res = await workerWithoutToken.fetch(`/api/v1/projects/${listProjectId}/sessions`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "auth_not_configured" });
  });

  it("rejects missing or wrong bearer tokens", async () => {
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

  it("allows only demo-readable routes without bearer auth", async () => {
    const sessions = await workerWithDemo.fetch(
      `/api/v1/projects/${demoProjectId}/sessions?limit=1`,
    );
    expect(sessions.status).toBe(200);
    expect(((await sessions.json()) as SessionsResponse).sessions).toHaveLength(1);

    const live = await workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({
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
    expect(((await stats.json()) as ProjectStats).sessions.value).toBe(61);

    const manifest = await workerWithDemo.fetch(
      `/api/v1/projects/${demoProjectId}/sessions/${demoSessionId}/manifest`,
    );
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe(demoManifestJson);

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

  it("does not fall back to demo when a bearer token is invalid", async () => {
    const res = await workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/sessions`, {
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("clamps demo session list limits to fifty", async () => {
    const res = await workerWithDemo.fetch(`/api/v1/projects/${demoProjectId}/sessions?limit=100`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionsResponse).sessions).toHaveLength(50);
  });

  it("rejects valid bearer tokens outside their project scope", async () => {
    const forbidden = await worker.fetch("/api/v1/projects/other_project/sessions", {
      headers: authHeaders(),
    });

    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
  });

  it("rejects missing or wrong bearer tokens for live, config, and install status", async () => {
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
