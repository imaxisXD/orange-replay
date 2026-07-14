import type { StoredProjectConfig } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  assetManifestJson,
  assetProjectId,
  assetSessionId,
  authHeaders,
  configProjectId,
  getProjectConfig,
  installProjectId,
  keysProjectId,
  liveProjectId,
  makeManifest,
  makeProjectConfig,
  makeSession,
  mintTicket,
  presencePing,
  readConfigCache,
  seedIngestKey,
  seedSession,
  segmentBytes,
  segmentName,
  setupApiTestWorkers,
  testWriteKey,
  worker,
} from "./api-test-helpers.ts";

setupApiTestWorkers();

describe("dashboard api", () => {
  it("streams manifests byte exact", async () => {
    const res = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/manifest`,
      { headers: authHeaders() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300, must-revalidate");
    expect(res.headers.get("vary")).toBe("Authorization");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe(assetManifestJson);
  });

  it("streams segments with immutable cache headers", async () => {
    const res = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/segments/${segmentName}`,
      { headers: authHeaders() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300, must-revalidate");
    expect(res.headers.get("vary")).toBe("Authorization");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(segmentBytes));
  });

  it("serves R2 recordings before D1 handoff and stops at a deletion fence", async () => {
    const session = makeSession({
      session_id: "api_cache_deleted_session",
      project_id: assetProjectId,
      started_at: 7000,
      ended_at: 8000,
      duration_ms: 1000,
      bytes: segmentBytes.byteLength,
      segment_count: 1,
    });
    const manifest = makeManifest(session, [{ name: segmentName, bytes: segmentBytes }]);
    await seedSession(session, manifest, [{ name: segmentName, bytes: segmentBytes }]);

    const segmentPath = `/api/v1/projects/${assetProjectId}/sessions/${session.session_id}/segments/${segmentName}`;
    const firstRead = await worker.fetch(segmentPath, { headers: authHeaders() });
    expect(firstRead.status).toBe(200);

    const deleteRow = await worker.fetch("/__test/api/delete-session-row", {
      method: "POST",
      body: JSON.stringify({ projectId: assetProjectId, sessionId: session.session_id }),
    });
    expect(deleteRow.status).toBe(200);

    const secondRead = await worker.fetch(segmentPath, { headers: authHeaders() });
    expect(secondRead.status).toBe(200);
    expect(Array.from(new Uint8Array(await secondRead.arrayBuffer()))).toEqual(
      Array.from(segmentBytes),
    );
    const manifestRead = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${session.session_id}/manifest`,
      { headers: authHeaders() },
    );
    expect(manifestRead.status).toBe(200);

    const deletion = await worker.fetch("/__test/consumer/seed-deletion", {
      method: "POST",
      body: JSON.stringify({ projectId: assetProjectId, sessionId: session.session_id }),
    });
    expect(deletion.status).toBe(200);
    expect((await worker.fetch(segmentPath, { headers: authHeaders() })).status).toBe(404);
    expect(
      (
        await worker.fetch(
          `/api/v1/projects/${assetProjectId}/sessions/${session.session_id}/manifest`,
          { headers: authHeaders() },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          `/api/v1/projects/${assetProjectId}/sessions/${session.session_id}/state`,
          { headers: authHeaders() },
        )
      ).status,
    ).toBe(404);
  });

  it("rejects unsafe segment names", async () => {
    const traversal = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/segments/..%2f..%2fmanifest.json`,
      { headers: authHeaders() },
    );
    expect(traversal.status).toBe(400);

    const shortName = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/segments/seg-1.ors`,
      { headers: authHeaders() },
    );
    expect(shortName.status).toBe(400);
  });

  it("requires websocket upgrade for live sessions", async () => {
    const ticket = await mintTicket(assetProjectId, assetSessionId);
    const res = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?ticket=${encodeURIComponent(
        ticket,
      )}`,
    );

    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: "websocket_required" });
  });

  it("lists live sessions from the presence registry", async () => {
    const lastSeen = Date.now();
    const startedAt = lastSeen - 500;
    await presencePing({
      projectId: liveProjectId,
      sessionId: "api_live_session",
      startedAt,
      lastSeen,
      entryUrl: "/live",
    });

    const res = await worker.fetch(`/api/v1/projects/${liveProjectId}/live`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessions: [
        {
          session_id: "api_live_session",
          started_at: startedAt,
          last_seen: lastSeen,
          entry_url: "/live",
          country: "US",
          city: "Austin",
          browser: "Chrome",
          os: "macOS",
          device: "desktop",
          duration_ms: expect.any(Number),
        },
      ],
    });
  });

  it("proxies install status from the presence registry", async () => {
    const empty = await worker.fetch(`/api/v1/projects/${installProjectId}/install-status`, {
      headers: authHeaders(),
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ firstEventAt: null });

    const firstEventAt = Date.now();
    await presencePing({
      projectId: installProjectId,
      sessionId: "api_install_session",
      startedAt: firstEventAt,
      lastSeen: firstEventAt,
      entryUrl: "/install",
    });

    const ready = await worker.fetch(`/api/v1/projects/${installProjectId}/install-status`, {
      headers: authHeaders(),
    });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ firstEventAt });
  });

  it("validates and stores project config in D1 before refreshing KV", async () => {
    const keyHash = await seedIngestKey(
      testWriteKey("api_config"),
      makeProjectConfig({ projectId: configProjectId }),
      true,
    );

    const before = await getProjectConfig(configProjectId);
    expect(before.version).toBe(1);
    expect(before.sampleRate).toBe(1);
    expect(before.retentionDays).toBe(30);

    const invalid = await worker.fetch(`/api/v1/projects/${configProjectId}/config`, {
      method: "PUT",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ sampleRate: 2 }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_project_config" });
    expect((await getProjectConfig(configProjectId)).version).toBe(1);

    const oversized = await worker.fetch(`/api/v1/projects/${configProjectId}/config`, {
      method: "PUT",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(70 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "body_too_large" });
    expect((await getProjectConfig(configProjectId)).version).toBe(1);

    const emptyOrigins = await worker.fetch(`/api/v1/projects/${configProjectId}/config`, {
      method: "PUT",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: before.version,
        sampleRate: 1,
        retentionDays: 30,
        allowedOrigins: [],
        maskPolicyVersion: 1,
        maskRules: [],
        capture: {
          heatmaps: false,
          console: false,
          network: false,
          canvas: false,
        },
      }),
    });
    expect(emptyOrigins.status).toBe(400);
    expect(await emptyOrigins.json()).toEqual({ error: "invalid_project_config" });
    expect((await getProjectConfig(configProjectId)).version).toBe(1);

    const update = {
      expectedVersion: before.version,
      sampleRate: 0.25,
      retentionDays: 45,
      allowedOrigins: ["https://app.example"],
      maskPolicyVersion: 2,
      maskRules: [{ selector: ".secret", action: "block" as const }],
      capture: {
        heatmaps: true,
        console: true,
        network: false,
        canvas: false,
      },
    };
    const saved = await worker.fetch(`/api/v1/projects/${configProjectId}/config`, {
      method: "PUT",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    expect(saved.status).toBe(200);
    const savedConfig = (await saved.json()) as StoredProjectConfig;

    expect(savedConfig).toMatchObject({
      projectId: configProjectId,
      sampleRate: 0.25,
      retentionDays: 45,
      allowedOrigins: ["https://app.example"],
      maskPolicyVersion: 2,
      maskRules: [{ selector: ".secret", action: "block" }],
      capture: update.capture,
      quotaState: "ok",
      version: 2,
    });

    const d1Config = await getProjectConfig(configProjectId);
    expect(d1Config).toEqual(savedConfig);

    const cached = await readConfigCache(keyHash);
    expect(cached).toEqual(savedConfig);

    const stale = await worker.fetch(`/api/v1/projects/${configProjectId}/config`, {
      method: "PUT",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        ...update,
        expectedVersion: before.version,
        sampleRate: 0.5,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "config_version_conflict" });
  });

  it("lists write key audit rows without plaintext keys", async () => {
    const keyHash = await seedIngestKey(
      testWriteKey("api_keys"),
      makeProjectConfig({ projectId: keysProjectId }),
      false,
    );

    const res = await worker.fetch(`/api/v1/projects/${keysProjectId}/keys`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      keys: [
        {
          key_hash: keyHash,
          active: true,
          created_at: expect.any(Number),
        },
      ],
    });
  });
});
