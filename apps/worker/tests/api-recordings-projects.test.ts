import { createHash } from "node:crypto";
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
  keyLimitProjectId,
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
          id: expect.any(String),
          name: "Legacy key",
          keyHashPrefix: keyHash.slice(0, 12),
          active: true,
          createdAt: expect.any(Number),
          createdBy: null,
          revokedAt: null,
          revokedBy: null,
        },
      ],
    });
  });

  it("shows a new write key once and durably revokes it before removing its cache", async () => {
    await seedIngestKey(
      testWriteKey("api_key_project"),
      makeProjectConfig({ projectId: keysProjectId }),
      false,
    );

    const created = await worker.fetch(`/api/v1/projects/${keysProjectId}/keys`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ name: "Production website" }),
    });
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    expect(created.headers.get("pragma")).toBe("no-cache");
    const createdBody = (await created.json()) as {
      key: { id: string; name: string; keyHashPrefix: string; active: boolean };
      secret: string;
    };
    expect(createdBody.secret).toMatch(/^or_live_[A-Za-z0-9_-]{32}$/);
    expect(createdBody.key).toMatchObject({
      id: expect.stringMatching(/^key_[A-Za-z0-9-]+$/),
      name: "Production website",
      active: true,
    });

    const keyHash = createHash("sha256").update(createdBody.secret).digest("hex");
    expect(createdBody.key.keyHashPrefix).toBe(keyHash.slice(0, 12));
    expect(await readConfigCache(keyHash)).toMatchObject({ active: true });

    const listed = await worker.fetch(`/api/v1/projects/${keysProjectId}/keys`, {
      headers: authHeaders(),
    });
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).not.toContain(createdBody.secret);
    expect(listedText).not.toContain(keyHash);

    const revoked = await worker.fetch(
      `/api/v1/projects/${keysProjectId}/keys/${createdBody.key.id}`,
      { method: "DELETE", headers: authHeaders() },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      key: {
        id: createdBody.key.id,
        active: false,
        revokedAt: expect.any(Number),
      },
    });
    expect(await readConfigCache(keyHash)).toBeNull();

    const afterRevoke = await worker.fetch(`/api/v1/projects/${keysProjectId}/keys`, {
      headers: authHeaders(),
    });
    expect(afterRevoke.status).toBe(200);
    const afterRevokeBody = (await afterRevoke.json()) as {
      keys: Array<{ id: string; active: boolean }>;
    };
    expect(afterRevokeBody.keys).toContainEqual(
      expect.objectContaining({ id: createdBody.key.id, active: false }),
    );
  });

  it("repairs a pending revoked-key cache before showing the key list", async () => {
    const writeKey = testWriteKey("api_pending_key_cache");
    const keyHash = await seedIngestKey(
      writeKey,
      makeProjectConfig({ projectId: keysProjectId }),
      true,
    );
    expect(await readConfigCache(keyHash)).toMatchObject({ active: true });

    const pending = await worker.fetch(
      `/__test/ingest/mark-key-cache-pending?keyHash=${encodeURIComponent(keyHash)}`,
      { method: "POST" },
    );
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ changed: 1 });

    const listed = await worker.fetch(`/api/v1/projects/${keysProjectId}/keys`, {
      headers: authHeaders(),
    });
    expect(listed.status).toBe(200);
    expect(await readConfigCache(keyHash)).toBeNull();

    const state = await worker.fetch(
      `/__test/ingest/key-state?keyHash=${encodeURIComponent(keyHash)}`,
    );
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({
      state: {
        active: 0,
        cacheSynced: 1,
        cacheFinalCheckAt: expect.any(Number),
        cacheWriteCount: 0,
      },
    });
  });

  it("keeps a final revoked-key cache check durable until its delete succeeds", async () => {
    const writeKey = testWriteKey("api_final_key_cache_check");
    const keyHash = await seedIngestKey(
      writeKey,
      makeProjectConfig({ projectId: keysProjectId }),
      true,
    );
    const pending = await worker.fetch(
      `/__test/ingest/mark-key-cache-pending?keyHash=${encodeURIComponent(keyHash)}&finalCheck=due`,
      { method: "POST" },
    );
    expect(pending.status).toBe(200);

    const listed = await worker.fetch(`/api/v1/projects/${keysProjectId}/keys`, {
      headers: authHeaders(),
    });
    expect(listed.status).toBe(200);
    expect(await readConfigCache(keyHash)).toBeNull();

    const state = await worker.fetch(
      `/__test/ingest/key-state?keyHash=${encodeURIComponent(keyHash)}`,
    );
    expect(await state.json()).toEqual({
      state: { active: 0, cacheSynced: 1, cacheFinalCheckAt: null, cacheWriteCount: 0 },
    });
  });

  it("repairs an active key cache from current D1 config and finishes its final check", async () => {
    const writeKey = testWriteKey("api_active_key_cache_repair");
    const activeCacheProjectId = "api_active_cache_project";
    const keyHash = await seedIngestKey(
      writeKey,
      makeProjectConfig({ projectId: activeCacheProjectId, sampleRate: 1 }),
      true,
    );
    const pending = await worker.fetch(
      `/__test/ingest/mark-active-key-cache-pending?keyHash=${encodeURIComponent(keyHash)}&finalCheck=due`,
      { method: "POST" },
    );
    expect(pending.status).toBe(200);
    expect(await readConfigCache(keyHash)).toMatchObject({ sampleRate: 1, version: 1 });

    const repaired = await worker.fetch("/__test/ingest/repair-active-key-cache", {
      method: "POST",
    });
    expect(repaired.status).toBe(200);
    expect(await readConfigCache(keyHash)).toMatchObject({ sampleRate: 0.5, version: 2 });

    const state = await worker.fetch(
      `/__test/ingest/key-state?keyHash=${encodeURIComponent(keyHash)}`,
    );
    expect(await state.json()).toEqual({
      state: { active: 1, cacheSynced: 1, cacheFinalCheckAt: null, cacheWriteCount: 0 },
    });
  });

  it("keeps repairing a revoked key while an older cache writer is unfinished", async () => {
    const writeKey = testWriteKey("api_unfinished_cache_writer");
    const keyHash = await seedIngestKey(
      writeKey,
      makeProjectConfig({ projectId: keysProjectId }),
      true,
    );
    const started = await worker.fetch(
      `/__test/ingest/start-key-cache-write?keyHash=${encodeURIComponent(keyHash)}`,
      { method: "POST" },
    );
    const { writeId } = (await started.json()) as { writeId: string };
    expect(started.status).toBe(200);

    const pending = await worker.fetch(
      `/__test/ingest/mark-key-cache-pending?keyHash=${encodeURIComponent(keyHash)}&finalCheck=due`,
      { method: "POST" },
    );
    expect(pending.status).toBe(200);
    const repairedAt = Date.now();
    await worker.fetch(`/api/v1/projects/${keysProjectId}/keys`, { headers: authHeaders() });

    const guardedState = await worker.fetch(
      `/__test/ingest/key-state?keyHash=${encodeURIComponent(keyHash)}`,
    );
    const guardedBody = (await guardedState.json()) as {
      state: {
        active: number;
        cacheSynced: number;
        cacheFinalCheckAt: number;
        cacheWriteCount: number;
      };
    };
    expect(guardedBody.state).toMatchObject({
      active: 0,
      cacheSynced: 1,
      cacheWriteCount: 1,
    });
    expect(guardedBody.state.cacheFinalCheckAt).toBeGreaterThan(repairedAt);

    const finished = await worker.fetch(
      `/__test/ingest/finish-key-cache-write?writeId=${encodeURIComponent(writeId)}`,
      { method: "POST" },
    );
    expect(finished.status).toBe(200);
    await worker.fetch(
      `/__test/ingest/mark-key-cache-pending?keyHash=${encodeURIComponent(keyHash)}&finalCheck=due`,
      { method: "POST" },
    );
    await worker.fetch(`/api/v1/projects/${keysProjectId}/keys`, { headers: authHeaders() });

    const finishedState = await worker.fetch(
      `/__test/ingest/key-state?keyHash=${encodeURIComponent(keyHash)}`,
    );
    expect(await finishedState.json()).toEqual({
      state: { active: 0, cacheSynced: 1, cacheFinalCheckAt: null, cacheWriteCount: 0 },
    });
  });

  it("gives other active keys a repair turn while an older cache writer is unfinished", async () => {
    const writeKey = testWriteKey("api_unfinished_active_cache_writer");
    const activeCacheProjectId = "api_unfinished_active_cache_project";
    const keyHash = await seedIngestKey(
      writeKey,
      makeProjectConfig({ projectId: activeCacheProjectId, sampleRate: 1 }),
      true,
    );
    const started = await worker.fetch(
      `/__test/ingest/start-key-cache-write?keyHash=${encodeURIComponent(keyHash)}`,
      { method: "POST" },
    );
    const { writeId } = (await started.json()) as { writeId: string };
    expect(started.status).toBe(200);

    const pending = await worker.fetch(
      `/__test/ingest/mark-active-key-cache-pending?keyHash=${encodeURIComponent(keyHash)}&finalCheck=due`,
      { method: "POST" },
    );
    expect(pending.status).toBe(200);
    const repairedAt = Date.now();
    const repaired = await worker.fetch("/__test/ingest/repair-active-key-cache", {
      method: "POST",
    });
    expect(repaired.status).toBe(200);

    const guardedState = await worker.fetch(
      `/__test/ingest/key-state?keyHash=${encodeURIComponent(keyHash)}`,
    );
    const guardedBody = (await guardedState.json()) as {
      state: {
        active: number;
        cacheSynced: number;
        cacheFinalCheckAt: number;
        cacheWriteCount: number;
      };
    };
    expect(guardedBody.state).toMatchObject({
      active: 1,
      cacheSynced: 1,
      cacheWriteCount: 1,
    });
    expect(guardedBody.state.cacheFinalCheckAt).toBeGreaterThan(repairedAt);

    const finished = await worker.fetch(
      `/__test/ingest/finish-key-cache-write?writeId=${encodeURIComponent(writeId)}`,
      { method: "POST" },
    );
    expect(finished.status).toBe(200);
    await worker.fetch(
      `/__test/ingest/mark-active-key-cache-pending?keyHash=${encodeURIComponent(keyHash)}&finalCheck=due`,
      { method: "POST" },
    );
    await worker.fetch("/__test/ingest/repair-active-key-cache", { method: "POST" });

    const finishedState = await worker.fetch(
      `/__test/ingest/key-state?keyHash=${encodeURIComponent(keyHash)}`,
    );
    expect(await finishedState.json()).toEqual({
      state: { active: 1, cacheSynced: 1, cacheFinalCheckAt: null, cacheWriteCount: 0 },
    });
  });

  it("keeps the active key limit exact when creates arrive together", async () => {
    await seedIngestKey(
      testWriteKey("api_key_limit_seed"),
      makeProjectConfig({ projectId: keyLimitProjectId }),
      false,
    );

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        worker.fetch(`/api/v1/projects/${keyLimitProjectId}/keys`, {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({ name: `Concurrent key ${index + 1}` }),
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(9);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);

    const listed = await worker.fetch(`/api/v1/projects/${keyLimitProjectId}/keys`, {
      headers: authHeaders(),
    });
    const body = (await listed.json()) as { keys: { active: boolean }[] };
    expect(body.keys.filter((key) => key.active)).toHaveLength(10);
  });
});
