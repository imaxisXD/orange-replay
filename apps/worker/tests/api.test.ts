import { createHmac } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  manifestKey,
  MAX_LIVE_VIEWERS_PER_SESSION,
  sessionPrefix,
  type ProjectConfig,
  type SessionManifest,
  type StoredProjectConfig,
} from "@orange-replay/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { unstable_dev } from "wrangler";
import type { SessionRow } from "../src/api/helpers.ts";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const token = "test-token-0000000000000000000000";
const liveTicketSecret = "test-live-ticket-secret-0000000000";
const listProjectId = "api_list_project";
const sameTimeProjectId = "api_same_time_project";
const assetProjectId = "api_asset_project";
const assetSessionId = "api_asset_session";
const liveProjectId = "api_live_project";
const installProjectId = "api_install_project";
const configProjectId = "api_config_project";
const keysProjectId = "api_keys_project";
const ticketProjectId = "api_ticket_project";
const ticketSessionId = "api_ticket_session";
const apiProjectIds = [
  listProjectId,
  sameTimeProjectId,
  assetProjectId,
  liveProjectId,
  installProjectId,
  configProjectId,
  keysProjectId,
  ticketProjectId,
].join(",");
const segmentName = "seg-000001.ors";
const segmentBytes = new Uint8Array([0, 1, 2, 3, 254, 255]);

let worker: Awaited<ReturnType<typeof unstable_dev>>;
let workerWithoutToken: Awaited<ReturnType<typeof unstable_dev>>;
let workerWithEmptyToken: Awaited<ReturnType<typeof unstable_dev>>;
let assetManifestJson = "";

beforeAll(async () => {
  worker = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: {
      DEV_TEST_ROUTES: "1",
      DEV_API_TOKEN: token,
      DEV_API_PROJECT_IDS: apiProjectIds,
      LIVE_TICKET_SECRET: liveTicketSecret,
    },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });

  await seedListSessions();
  assetManifestJson = await seedAssetSession();
}, 120_000);

beforeAll(async () => {
  workerWithoutToken = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: { DEV_TEST_ROUTES: "1" },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });
}, 120_000);

beforeAll(async () => {
  workerWithEmptyToken = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: {
      DEV_TEST_ROUTES: "1",
      DEV_API_TOKEN: "",
      DEV_API_PROJECT_IDS: apiProjectIds,
      LIVE_TICKET_SECRET: liveTicketSecret,
    },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await workerWithoutToken?.stop();
  await workerWithEmptyToken?.stop();
});

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

  it("rejects valid bearer tokens outside their project scope", async () => {
    const forbidden = await worker.fetch("/api/v1/projects/other_project/sessions", {
      headers: authHeaders(),
    });

    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
  });

  it("rejects missing or wrong bearer tokens for live, config, and install status", async () => {
    const paths = [
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

  it("lists sessions newest first and applies filters", async () => {
    const all = await getSessions();
    expect(all.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_mid",
      "api_old",
    ]);
    expect(all.nextBefore).toBe("1000:api_old");

    const withErrors = await getSessions("has_errors=1");
    expect(withErrors.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_mid",
    ]);

    const longSessions = await getSessions("min_duration_ms=2000");
    expect(longSessions.sessions.map((session) => session.session_id)).toEqual(["api_new"]);

    const chromeInUs = await getSessions("country=US&browser=Chrome");
    expect(chromeInUs.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_old",
    ]);
  });

  it("paginates sessions with the before cursor", async () => {
    const firstPage = await getSessions("limit=1");
    expect(firstPage.sessions.map((session) => session.session_id)).toEqual(["api_new"]);
    expect(firstPage.nextBefore).toBe("3000:api_new");

    const secondPage = await getSessions(`limit=1&before=${firstPage.nextBefore}`);
    expect(secondPage.sessions.map((session) => session.session_id)).toEqual(["api_mid"]);
    expect(secondPage.nextBefore).toBe("2000:api_mid");
  });

  it("paginates sessions that share the same millisecond", async () => {
    const seen: string[] = [];
    let before = "";

    for (;;) {
      const query = before.length === 0 ? "limit=1" : `limit=1&before=${before}`;
      const page = await getSessions(query, sameTimeProjectId);
      const session = page.sessions[0];
      if (session === undefined) break;

      seen.push(session.session_id);
      if (page.nextBefore === null || seen.length >= 3) break;
      before = page.nextBefore;
    }

    expect(seen).toEqual(["same_c", "same_b", "same_a"]);
  });

  it("streams manifests byte exact", async () => {
    const res = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/manifest`,
      { headers: authHeaders() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
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
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("vary")).toBe("Authorization");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(segmentBytes));
  });

  it("does not serve cached segments after the session row is gone", async () => {
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
    expect(secondRead.status).toBe(404);
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

  it("mints live tickets only with bearer auth", async () => {
    const missing = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live-ticket`,
      { method: "POST" },
    );
    expect(missing.status).toBe(401);

    const res = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live-ticket`,
      {
        method: "POST",
        headers: authHeaders(),
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticket: expect.any(String),
      expiresAt: expect.any(Number),
    });
  });

  it("returns the durable object's live response status with a valid ticket", async () => {
    const ticket = await mintTicket(assetProjectId, assetSessionId);
    const res = await requestLiveUpgrade(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?ticket=${encodeURIComponent(
        ticket,
      )}`,
    );

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
  });

  it("connects live WebSockets with tickets and rejects token fallback", async () => {
    await seedIngestKey(
      testWriteKey("api_ticket"),
      makeProjectConfig({ projectId: ticketProjectId, orgId: "api_ticket_org" }),
      false,
    );
    await appendActiveSession(ticketProjectId, ticketSessionId);

    const ticket = await mintTicket(ticketProjectId, ticketSessionId);
    const connected = await requestLiveUpgrade(
      `/api/v1/projects/${ticketProjectId}/sessions/${ticketSessionId}/live?ticket=${encodeURIComponent(
        ticket,
      )}`,
    );
    expect(connected.status).toBe(101);

    const tokenFallback = await requestLiveUpgrade(
      `/api/v1/projects/${ticketProjectId}/sessions/${ticketSessionId}/live?token=${token}`,
    );
    expect(tokenFallback.status).toBe(401);
    expect(JSON.parse(tokenFallback.body)).toEqual({ error: "unauthorized" });
  });

  it("caps concurrent live viewers per session even when one ticket is replayed", async () => {
    const capProjectId = ticketProjectId;
    const capSessionId = "api_cap_session";
    await appendActiveSession(capProjectId, capSessionId);

    // One ticket, replayed: connections succeed only up to the viewer cap.
    const ticket = await mintTicket(capProjectId, capSessionId);
    const path = `/api/v1/projects/${capProjectId}/sessions/${capSessionId}/live?ticket=${encodeURIComponent(
      ticket,
    )}`;
    const held: Socket[] = [];
    try {
      for (let i = 0; i < MAX_LIVE_VIEWERS_PER_SESSION; i++) {
        const res = await requestLiveUpgrade(path, worker, held);
        expect(res.status).toBe(101);
      }

      const rejected = await requestLiveUpgrade(path, worker, held);
      expect(rejected.status).toBe(429);
      expect(JSON.parse(rejected.body)).toEqual({ error: "viewer_limit" });
    } finally {
      for (const socket of held) socket.destroy();
    }
  });

  it("rejects garbage, expired, and cross-session live tickets", async () => {
    const validForOtherSession = await mintTicket(assetProjectId, "other_session");
    const expired = signLiveTicket(assetProjectId, assetSessionId, Date.now() - 1);

    for (const ticket of ["garbage", expired, validForOtherSession]) {
      const res = await requestLiveUpgrade(
        `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?ticket=${encodeURIComponent(
          ticket,
        )}`,
      );
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
    }
  });

  it("rejects forged live tickets when the API token is empty", async () => {
    const forged = signLiveTicketWithSecret(
      "",
      assetProjectId,
      assetSessionId,
      Date.now() + 60_000,
    );
    const res = await requestLiveUpgrade(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?ticket=${encodeURIComponent(
        forged,
      )}`,
      workerWithEmptyToken,
    );

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });

  it("rejects live tickets signed with the dashboard API token", async () => {
    const forged = signLiveTicketWithSecret(
      token,
      assetProjectId,
      assetSessionId,
      Date.now() + 60_000,
    );
    const res = await requestLiveUpgrade(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?ticket=${encodeURIComponent(
        forged,
      )}`,
    );

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });
});

interface SessionsResponse {
  sessions: SessionRow[];
  nextBefore: string | null;
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface HttpResponse {
  status: number;
  body: string;
}

function requestLiveUpgrade(
  path: string,
  targetWorker = worker,
  // When provided, upgraded sockets are kept open (and collected here) so a
  // test can hold concurrent viewers; the caller destroys them.
  holdSockets?: Socket[],
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: targetWorker.address,
        port: targetWorker.port,
        method: "GET",
        path,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          // workerd rejects handshakes missing the WS key/version with 400.
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      },
      (response) => {
        readHttpResponse(response).then(resolve, reject);
      },
    );

    request.on("upgrade", (response, socket) => {
      if (holdSockets === undefined) {
        socket.destroy();
      } else {
        holdSockets.push(socket);
      }
      resolve({
        status: response.statusCode ?? 0,
        body: "",
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function readHttpResponse(response: IncomingMessage): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    response.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on("error", reject);
    response.on("end", () => {
      resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

async function getSessions(query = "", projectId = listProjectId): Promise<SessionsResponse> {
  const suffix = query.length > 0 ? `?${query}` : "";
  const res = await worker.fetch(`/api/v1/projects/${projectId}/sessions${suffix}`, {
    headers: authHeaders(),
  });

  expect(res.status).toBe(200);
  return (await res.json()) as SessionsResponse;
}

async function seedListSessions(): Promise<void> {
  const sessions = [
    makeSession({
      session_id: "api_old",
      project_id: listProjectId,
      started_at: 1000,
      ended_at: 1500,
      duration_ms: 500,
      country: "US",
      browser: "Chrome",
      errors: 0,
    }),
    makeSession({
      session_id: "api_mid",
      project_id: listProjectId,
      started_at: 2000,
      ended_at: 3500,
      duration_ms: 1500,
      country: "IN",
      browser: "Firefox",
      errors: 2,
    }),
    makeSession({
      session_id: "api_new",
      project_id: listProjectId,
      started_at: 3000,
      ended_at: 5500,
      duration_ms: 2500,
      country: "US",
      browser: "Chrome",
      errors: 1,
    }),
  ];

  for (const session of sessions) {
    await seedSession(session, makeManifest(session, []), []);
  }

  const sameTimeSessions = ["same_a", "same_b", "same_c"].map((sessionId) =>
    makeSession({
      session_id: sessionId,
      project_id: sameTimeProjectId,
      started_at: 6000,
      ended_at: 6500,
      duration_ms: 500,
    }),
  );

  for (const session of sameTimeSessions) {
    await seedSession(session, makeManifest(session, []), []);
  }
}

async function seedAssetSession(): Promise<string> {
  const session = makeSession({
    session_id: assetSessionId,
    project_id: assetProjectId,
    started_at: 4000,
    ended_at: 5000,
    duration_ms: 1000,
    bytes: segmentBytes.byteLength,
    segment_count: 1,
  });
  const manifest = makeManifest(session, [{ name: segmentName, bytes: segmentBytes }]);
  await seedSession(session, manifest, [{ name: segmentName, bytes: segmentBytes }]);
  return JSON.stringify(manifest);
}

async function seedIngestKey(key: string, config: ProjectConfig, kv: boolean): Promise<string> {
  const res = await worker.fetch("/__test/ingest/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, config, kv }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { keyHash: string };
  return body.keyHash;
}

async function readConfigCache(keyHash: string): Promise<StoredProjectConfig | null> {
  const res = await worker.fetch(
    `/__test/ingest/config-cache?keyHash=${encodeURIComponent(keyHash)}`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { config: StoredProjectConfig | null };
  return body.config;
}

async function getProjectConfig(projectId: string): Promise<StoredProjectConfig> {
  const res = await worker.fetch(`/api/v1/projects/${projectId}/config`, {
    headers: authHeaders(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as StoredProjectConfig;
}

async function mintTicket(projectId: string, sessionId: string): Promise<string> {
  const res = await worker.fetch(
    `/api/v1/projects/${projectId}/sessions/${sessionId}/live-ticket`,
    {
      method: "POST",
      headers: authHeaders(),
    },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}

async function appendActiveSession(projectId: string, sessionId: string): Promise<void> {
  const res = await worker.fetch("/__test/do/append", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      orgId: "api_ticket_org",
      shard: 0,
      retentionDays: 7,
      requestId: `req-${projectId}-${sessionId}`,
      sessionId,
      tab: "tab_ticket",
      seq: 0,
      flags: 0,
      index: {
        v: 1,
        s: sessionId,
        tab: "tab_ticket",
        seq: 0,
        t0: Date.now(),
        t1: Date.now() + 1,
        e: [],
      },
      payloadB64: Buffer.from("live-ticket-payload").toString("base64"),
      attrs: { country: "US" },
      receivedAt: Date.now(),
    }),
  });
  expect(res.status).toBe(200);
}

async function presencePing(input: {
  projectId: string;
  sessionId: string;
  startedAt: number;
  lastSeen: number;
  entryUrl: string;
}): Promise<void> {
  const res = await worker.fetch("/__test/do/presence/ping", {
    method: "POST",
    body: JSON.stringify({
      projectId: input.projectId,
      sessionId: input.sessionId,
      startedAt: input.startedAt,
      lastSeen: input.lastSeen,
      entryUrl: input.entryUrl,
      country: "US",
      city: "Austin",
      browser: "Chrome",
      os: "macOS",
      device: "desktop",
    }),
  });
  expect(res.status).toBe(200);
}

async function seedSession(
  session: SessionRow,
  manifest: SessionManifest,
  segments: { name: string; bytes: Uint8Array }[],
): Promise<void> {
  const res = await worker.fetch("/__test/api/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session,
      manifest,
      segments: segments.map((segment) => ({
        name: segment.name,
        bytesB64: Buffer.from(segment.bytes).toString("base64"),
      })),
    }),
  });

  expect(res.status).toBe(200);
}

function makeSession(overrides: Partial<SessionRow>): SessionRow {
  const sessionId = overrides.session_id ?? "api_session";
  const projectId = overrides.project_id ?? listProjectId;
  const startedAt = overrides.started_at ?? 1000;
  const durationMs = overrides.duration_ms ?? 1000;

  return {
    session_id: sessionId,
    project_id: projectId,
    org_id: overrides.org_id ?? "api_org",
    started_at: startedAt,
    ended_at: overrides.ended_at ?? startedAt + durationMs,
    duration_ms: durationMs,
    country: overrides.country ?? "US",
    region: overrides.region ?? null,
    city: overrides.city ?? null,
    device: overrides.device ?? "desktop",
    browser: overrides.browser ?? "Chrome",
    os: overrides.os ?? "macOS",
    entry_url: overrides.entry_url ?? "/",
    url_count: overrides.url_count ?? 1,
    clicks: overrides.clicks ?? 0,
    errors: overrides.errors ?? 0,
    rages: overrides.rages ?? 0,
    navs: overrides.navs ?? 0,
    bytes: overrides.bytes ?? 0,
    segment_count: overrides.segment_count ?? 0,
    flags: overrides.flags ?? 0,
    manifest_key: overrides.manifest_key ?? manifestKey(projectId, sessionId),
    expires_at: overrides.expires_at ?? 9_999_999_999,
  };
}

function makeManifest(
  session: SessionRow,
  segments: { name: string; bytes: Uint8Array }[],
): SessionManifest {
  return {
    v: 1,
    sessionId: session.session_id,
    projectId: session.project_id,
    orgId: session.org_id,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    durationMs: session.duration_ms,
    segments: segments.map((segment) => ({
      key: `${sessionPrefix(session.project_id, session.session_id)}/${segment.name}`,
      bytes: segment.bytes.byteLength,
      t0: session.started_at,
      t1: session.ended_at,
      batches: 1,
    })),
    timeline: [],
    counts: {
      batches: segments.length,
      events: 0,
      clicks: session.clicks,
      errors: session.errors,
      rages: session.rages,
      navs: session.navs,
    },
    bytes: session.bytes,
    flags: session.flags,
    attrs: {
      country: session.country ?? undefined,
      region: session.region ?? undefined,
      city: session.city ?? undefined,
      device: session.device ?? undefined,
      browser: session.browser ?? undefined,
      os: session.os ?? undefined,
      entryUrl: session.entry_url ?? undefined,
      urlCount: session.url_count,
    },
  };
}

function signLiveTicket(projectId: string, sessionId: string, expiresAt: number): string {
  return signLiveTicketWithSecret(liveTicketSecret, projectId, sessionId, expiresAt);
}

function signLiveTicketWithSecret(
  secret: string,
  projectId: string,
  sessionId: string,
  expiresAt: number,
): string {
  const signature = createHmac("sha256", secret)
    .update(`${projectId}:${sessionId}:${expiresAt}`)
    .digest("base64url");
  return Buffer.from(`${expiresAt}.${signature}`).toString("base64url");
}

function makeProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    projectId: "api_project",
    orgId: "api_org",
    shard: 0,
    active: true,
    sampleRate: 1,
    allowedOrigins: ["*"],
    maskPolicyVersion: 1,
    maskRules: [],
    capture: {
      heatmaps: false,
      console: false,
      network: false,
      canvas: false,
    },
    quotaState: "ok",
    retentionDays: 30,
    version: 1,
    ...overrides,
  };
}

function testWriteKey(label: string): string {
  return `or_live_${label
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .padEnd(32, "0")
    .slice(0, 32)}`;
}
