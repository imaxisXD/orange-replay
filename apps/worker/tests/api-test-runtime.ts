import { fileURLToPath } from "node:url";
import type { SessionManifest } from "@orange-replay/shared";
import { afterAll, beforeAll, expect } from "vite-plus/test";
import { unstable_dev } from "wrangler";
import type { SessionRow } from "../src/query/session-query.ts";
import {
  assetProjectId,
  assetSessionId,
  demoProjectId,
  demoSessionId,
  demoWriteKey,
  entryPageProjectId,
  listProjectId,
  liveTicketSecret,
  makeManifest,
  makeSession,
  sameTimeProjectId,
  segmentBytes,
  segmentName,
  betterAuthOrigin,
  betterAuthSecret,
  privateProjectIds,
} from "./api-test-fixtures.ts";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
type TestWorker = Awaited<ReturnType<typeof unstable_dev>>;

export let worker: TestWorker;
export let workerWithoutAuth: TestWorker;
export let workerWithoutLiveTicketSecret: TestWorker;
export let workerWithDemo: TestWorker;
export let workerWithPresenceHeadFailure: TestWorker;
export let assetManifestJson = "";
export let demoManifestJson = "";
export let dashboardSessionCookie = "";

interface SetupApiTestWorkersOptions {
  withoutAuth?: boolean;
  withoutLiveTicketSecret?: boolean;
  demo?: boolean;
  presenceHeadFailure?: boolean;
}

export function setupApiTestWorkers(options: SetupApiTestWorkersOptions = {}): void {
  beforeAll(async () => {
    worker = await unstable_dev(`${workerDir}src/index.ts`, {
      config: `${workerDir}wrangler.jsonc`,
      vars: {
        DEV_TEST_ROUTES: "1",
        ...betterAuthVars(),
        LIVE_TICKET_SECRET: liveTicketSecret,
      },
      persist: false,
      experimental: { disableExperimentalWarning: true },
    });

    await seedListSessions();
    await seedEntryPageSessions();
    const statsLiveNow = Date.now();
    await presencePing({
      projectId: listProjectId,
      sessionId: "api_stats_live",
      startedAt: statsLiveNow - 5_000,
      lastSeen: statsLiveNow,
      entryUrl: "/checkout/live",
    });
    assetManifestJson = await seedAssetSession();
    dashboardSessionCookie = await seedBetterAuthSession(worker, privateProjectIds);
  }, 120_000);

  if (options.withoutAuth === true) {
    beforeAll(async () => {
      workerWithoutAuth = await unstable_dev(`${workerDir}src/index.ts`, {
        config: `${workerDir}wrangler.jsonc`,
        vars: { DEV_TEST_ROUTES: "1" },
        persist: false,
        experimental: { disableExperimentalWarning: true },
      });
    }, 120_000);
  }

  if (options.withoutLiveTicketSecret === true) {
    beforeAll(async () => {
      workerWithoutLiveTicketSecret = await unstable_dev(`${workerDir}src/index.ts`, {
        config: `${workerDir}wrangler.jsonc`,
        vars: {
          DEV_TEST_ROUTES: "1",
          ...betterAuthVars(),
        },
        persist: false,
        experimental: { disableExperimentalWarning: true },
      });
    }, 120_000);
  }

  if (options.demo === true) {
    beforeAll(async () => {
      workerWithDemo = await unstable_dev(`${workerDir}src/index.ts`, {
        config: `${workerDir}wrangler.jsonc`,
        vars: {
          DEV_TEST_ROUTES: "1",
          ...betterAuthVars(),
          LIVE_TICKET_SECRET: liveTicketSecret,
          DEMO_PROJECT_ID: demoProjectId,
          DEMO_WRITE_KEY: demoWriteKey,
        },
        persist: false,
        experimental: { disableExperimentalWarning: true },
      });

      demoManifestJson = await seedDemoWorkspace();
    }, 120_000);
  }

  if (options.presenceHeadFailure === true) {
    beforeAll(async () => {
      workerWithPresenceHeadFailure = await unstable_dev(`${workerDir}src/index.ts`, {
        config: `${workerDir}wrangler.jsonc`,
        vars: {
          DEV_TEST_ROUTES: "1",
          ...betterAuthVars(),
          LIVE_TICKET_SECRET: liveTicketSecret,
          TEST_FAIL_PRESENCE_HEAD_SHARD: "0",
        },
        persist: false,
        experimental: { disableExperimentalWarning: true },
      });
      await seedBetterAuthSession(workerWithPresenceHeadFailure, [listProjectId]);
    }, 120_000);
  }

  afterAll(async () => {
    await worker?.stop();
    await workerWithoutAuth?.stop();
    await workerWithoutLiveTicketSecret?.stop();
    await workerWithDemo?.stop();
    await workerWithPresenceHeadFailure?.stop();
  });
}

function betterAuthVars(): Record<string, string> {
  return {
    BETTER_AUTH_SECRET: betterAuthSecret,
    BETTER_AUTH_URL: betterAuthOrigin,
    BETTER_AUTH_TRUSTED_ORIGINS: betterAuthOrigin,
    GITHUB_CLIENT_ID: "github-test-client-id",
    GITHUB_CLIENT_SECRET: "github-test-client-secret-0000000000",
  };
}

async function seedBetterAuthSession(
  targetWorker: TestWorker,
  projectIds: readonly string[],
): Promise<string> {
  const response = await targetWorker.fetch("/__test/api/hosted/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectIds }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { cookie?: unknown };
  expect(body.cookie).toEqual(expect.any(String));
  if (typeof body.cookie !== "string") throw new Error("Test Better Auth cookie was not created.");
  return body.cookie;
}

async function seedListSessions(): Promise<void> {
  const sessions = [
    makeSession({
      session_id: "api_old",
      project_id: listProjectId,
      started_at: 1000,
      ended_at: 2500,
      duration_ms: 1500,
      country: "US",
      region: "CA",
      city: "San Jose",
      browser: "Chrome",
      entry_url: "/checkout/start",
      page_count: null,
      analytics_version: 0,
      clicks: 3,
      errors: 0,
    }),
    makeSession({
      session_id: "api_mid",
      project_id: listProjectId,
      started_at: 2000,
      ended_at: 2500,
      duration_ms: 500,
      country: "IN",
      region: "KA",
      city: "Bengaluru",
      device: "mobile",
      browser: "Firefox",
      os: "Android",
      entry_url: "/pricing",
      page_count: 2,
      clicks: 1,
      errors: 2,
      analytics_version: 2,
      max_scroll_depth: 50,
      quick_backs: 0,
      interaction_time_ms: 4_000,
    }),
    makeSession({
      session_id: "api_new",
      project_id: listProjectId,
      started_at: 3000,
      ended_at: 5500,
      duration_ms: 2500,
      country: "US",
      region: "NY",
      city: "San Jose",
      browser: "Chrome",
      entry_url: "/checkout/complete",
      page_count: 1,
      analytics_version: 2,
      max_scroll_depth: 100,
      quick_backs: 2,
      interaction_time_ms: 6_000,
      clicks: 2,
      errors: 1,
      rages: 1,
    }),
  ];

  for (const session of sessions) {
    await seedSession(session, makeManifest(session, []), []);
  }

  const middleSession = sessions[1];
  const newestSession = sessions[2];
  if (middleSession !== undefined) {
    await seedSessionEvents(middleSession, [
      { t: 2100, kind: "error", detail: "Checkout failed" },
      { t: 2200, kind: "error", detail: "Network timeout" },
    ]);
  }
  if (newestSession !== undefined) {
    await seedSessionEvents(newestSession, [{ t: 3100, kind: "error", detail: "Checkout failed" }]);
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

async function seedEntryPageSessions(): Promise<void> {
  const sessions = [
    makeSession({
      session_id: "entry_shop",
      project_id: entryPageProjectId,
      started_at: 4_000,
      entry_url: "/shop",
    }),
    makeSession({
      session_id: "entry_shop_cart",
      project_id: entryPageProjectId,
      started_at: 5_000,
      entry_url: "/shop/cart",
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

async function seedDemoWorkspace(): Promise<string> {
  for (let index = 0; index < 60; index += 1) {
    const session = makeSession({
      session_id: `api_demo_list_${String(index).padStart(2, "0")}`,
      project_id: demoProjectId,
      started_at: 10_000 + index,
      ended_at: 10_500 + index,
      duration_ms: 500,
    });
    await seedSession(session, makeManifest(session, []), [], workerWithDemo);
  }

  const session = makeSession({
    session_id: demoSessionId,
    project_id: demoProjectId,
    started_at: 20_000,
    ended_at: 21_000,
    duration_ms: 1000,
    bytes: segmentBytes.byteLength,
    segment_count: 1,
  });
  const manifest = makeManifest(session, [{ name: segmentName, bytes: segmentBytes }]);
  await seedSession(
    session,
    manifest,
    [{ name: segmentName, bytes: segmentBytes }],
    workerWithDemo,
  );

  const lastSeen = Date.now();
  await presencePing(
    {
      projectId: demoProjectId,
      sessionId: "api_demo_live",
      startedAt: lastSeen - 500,
      lastSeen,
      entryUrl: "/demo-live",
    },
    workerWithDemo,
  );

  return JSON.stringify(manifest);
}

export async function appendActiveSession(
  projectId: string,
  sessionId: string,
  entryUrl?: string,
): Promise<void> {
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
        ...(entryUrl === undefined ? {} : { u: entryUrl }),
        e: [],
      },
      payloadB64: Buffer.from("live-ticket-payload").toString("base64"),
      attrs: { country: "US" },
      receivedAt: Date.now(),
    }),
  });
  expect(res.status).toBe(200);
}

export async function presencePing(
  input: {
    projectId: string;
    sessionId: string;
    startedAt: number;
    lastSeen: number;
    entryUrl: string;
  },
  targetWorker = worker,
): Promise<void> {
  const res = await targetWorker.fetch("/__test/do/presence/ping", {
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

export async function presenceRemove(projectId: string, sessionId: string): Promise<void> {
  const res = await worker.fetch("/__test/do/presence/remove", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId }),
  });
  expect(res.status).toBe(200);
}

export async function seedSession(
  session: SessionRow,
  manifest: SessionManifest,
  segments: { name: string; bytes: Uint8Array }[],
  targetWorker = worker,
): Promise<void> {
  const res = await targetWorker.fetch("/__test/api/seed", {
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

async function seedSessionEvents(
  session: SessionRow,
  events: { t: number; kind: "error"; detail: string }[],
): Promise<void> {
  const res = await worker.fetch("/__test/consumer/seed-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, events, r2Keys: [] }),
  });
  expect(res.status).toBe(200);
}
