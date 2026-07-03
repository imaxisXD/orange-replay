import { request as httpRequest, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { manifestKey, sessionPrefix, type SessionManifest } from "@orange-replay/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { unstable_dev } from "wrangler";
import type { SessionRow } from "../src/api/helpers.ts";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const token = "test-token";
const listProjectId = "api_list_project";
const assetProjectId = "api_asset_project";
const assetSessionId = "api_asset_session";
const segmentName = "seg-000001.ors";
const segmentBytes = new Uint8Array([0, 1, 2, 3, 254, 255]);

let worker: Awaited<ReturnType<typeof unstable_dev>>;
let workerWithoutToken: Awaited<ReturnType<typeof unstable_dev>>;
let assetManifestJson = "";

beforeAll(async () => {
  worker = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: { DEV_TEST_ROUTES: "1", DEV_API_TOKEN: token },
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

afterAll(async () => {
  await worker?.stop();
  await workerWithoutToken?.stop();
});

describe("dashboard api", () => {
  it("serves health without auth", async () => {
    const res = await worker.fetch("/api/v1/health");

    expect(res.status).toBe(200);
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

  it("lists sessions newest first and applies filters", async () => {
    const all = await getSessions();
    expect(all.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_mid",
      "api_old",
    ]);
    expect(all.nextBefore).toBe(1000);

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
    expect(firstPage.nextBefore).toBe(3000);

    const secondPage = await getSessions(`limit=1&before=${firstPage.nextBefore}`);
    expect(secondPage.sessions.map((session) => session.session_id)).toEqual(["api_mid"]);
    expect(secondPage.nextBefore).toBe(2000);
  });

  it("streams manifests byte exact", async () => {
    const res = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/manifest`,
      { headers: authHeaders() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
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
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(segmentBytes));
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
    const res = await worker.fetch(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live`,
      { headers: authHeaders() },
    );

    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: "websocket_required" });
  });

  it("returns the durable object's live response status", async () => {
    const res = await requestLiveUpgrade(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?token=${token}`,
    );

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
  });

  it("rejects a wrong live query token before reaching the durable object", async () => {
    const res = await requestLiveUpgrade(
      `/api/v1/projects/${assetProjectId}/sessions/${assetSessionId}/live?token=wrong-token`,
    );

    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });
});

interface SessionsResponse {
  sessions: SessionRow[];
  nextBefore: number | null;
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface HttpResponse {
  status: number;
  body: string;
}

function requestLiveUpgrade(path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: worker.address,
        port: worker.port,
        method: "GET",
        path,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
        },
      },
      (response) => {
        readHttpResponse(response).then(resolve, reject);
      },
    );

    request.on("upgrade", (response, socket) => {
      socket.destroy();
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

async function getSessions(query = ""): Promise<SessionsResponse> {
  const suffix = query.length > 0 ? `?${query}` : "";
  const res = await worker.fetch(`/api/v1/projects/${listProjectId}/sessions${suffix}`, {
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
