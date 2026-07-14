import { fileURLToPath } from "node:url";
import { manifestKey, sessionPrefix, type FinalizeMessage } from "@orange-replay/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { unstable_dev } from "wrangler";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const pollDelayMs = 100;

let worker: Awaited<ReturnType<typeof unstable_dev>>;

beforeAll(async () => {
  worker = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: { DEV_TEST_ROUTES: "1" },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });

  const res = await worker.fetch("/__test/consumer/seed-schema", { method: "POST" });
  expect(res.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await worker?.stop();
});

interface ConsumerSessionBody {
  session: Record<string, unknown> | null;
  events: Record<string, unknown>[];
  usage: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
}

describe("consumer queue and sweeper", () => {
  it("indexes a valid finalize message", async () => {
    const message = makeFinalizeMessage("valid");

    await sendFinalizeMessage(message);
    const body = await waitForSession(message.sessionId);

    expect(body.session?.["session_id"]).toBe(message.sessionId);
    expect(body.session?.["project_id"]).toBe(message.projectId);
    expect(body.session?.["org_id"]).toBe(message.orgId);
    expect(body.session?.["expires_at"]).toBe(message.endedAt + 30 * 86_400_000);
    expect(body.session?.["clicks"]).toBe(4);
    expect(body.session?.["errors"]).toBe(1);
    expect(body.session?.["page_count"]).toBe(3);
    expect(body.session?.["analytics_version"]).toBe(2);
    expect(body.session?.["max_scroll_depth"]).toBe(84);
    expect(body.session?.["quick_backs"]).toBe(2);
    expect(body.session?.["interaction_time_ms"]).toBe(8_500);
    expect(body.session?.["segment_count"]).toBe(2);
    expect(body.session?.["flags"]).toBe(message.flags);
    expect(body.session?.["manifest_key"]).toBe(message.manifestKey);
    expect(body.session?.["indexed_at"]).toEqual(expect.any(Number));
    expect(Number(body.session?.["indexed_at"])).toBeGreaterThan(0);

    expect(body.events).toHaveLength(2);
    expect(body.events[0]?.["kind"]).toBe("error");
    expect(String(body.events[0]?.["detail"])).toHaveLength(200);
    expect(body.outbox).toEqual([]);
    expect(body.usage).toEqual([
      {
        org_id: message.orgId,
        month: "2026-01",
        sessions: 1,
        bytes: message.bytes,
      },
    ]);
  }, 30_000);

  it("keeps page count unknown for legacy finalize messages", async () => {
    const message = makeFinalizeMessage("legacy-analytics");
    delete message.analyticsVersion;
    delete message.insights;
    delete message.attrs.pageCount;

    await sendFinalizeMessage(message);
    const body = await waitForSession(message.sessionId);

    expect(body.session?.["page_count"]).toBeNull();
    expect(body.session?.["analytics_version"]).toBe(0);
    expect(body.session?.["max_scroll_depth"]).toBeNull();
    expect(body.session?.["quick_backs"]).toBeNull();
    expect(body.session?.["interaction_time_ms"]).toBeNull();
  }, 30_000);

  it("does not double count a redelivered finalize message", async () => {
    const message = makeFinalizeMessage("idempotent");

    await sendFinalizeMessage(message);
    const firstBody = await waitForSession(message.sessionId);
    const firstIndexedAt = firstBody.session?.["indexed_at"];
    await sendFinalizeMessage(message);
    const body = await waitForStableUsage(message.sessionId);

    expect(body.session?.["indexed_at"]).toBe(firstIndexedAt);
    expect(body.usage[0]?.["sessions"]).toBe(1);
    expect(body.usage[0]?.["bytes"]).toBe(message.bytes);
    expect(body.events).toHaveLength(2);
    expect(body.outbox).toEqual([]);
  }, 30_000);

  it("removes the finalizing presence row only after the session commit", async () => {
    const message = makeFinalizeMessage("presence-handoff");
    const presenceNow = Date.now();
    await writePresence(message, "/ping", {
      startedAt: presenceNow - 1_000,
      lastSeen: presenceNow,
      entryUrl: message.attrs.entryUrl,
    });
    await writePresence(message, "/mark-finalizing", { finalizingAt: Date.now() });
    expect(await readPresenceHeads(message)).toMatchObject({
      sessions: [{ session_id: message.sessionId, activity: "finalizing" }],
    });

    await sendFinalizeMessage(message);
    await waitForSession(message.sessionId);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const heads = await readPresenceHeads(message);
      if (heads.sessions.length === 0) break;
      if (Date.now() >= deadline) throw new Error("finalized presence row was not removed");
      await delay(50);
    }
  }, 30_000);

  it("indexes 200 sparse events without crossing D1's parameter limit", async () => {
    const message = makeFinalizeMessage("many-events");
    message.events = Array.from({ length: 200 }, (_, index) => ({
      t: message.startedAt + index + 1,
      k: index % 2 === 0 ? ("error" as const) : ("custom" as const),
      d: `event-${String(index)}`,
    }));
    message.counts.events = 200;
    message.counts.errors = 100;

    const response = await worker.fetch("/__test/consumer/index-now", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inserted: true, eventsWritten: 200 });

    const body = await readSession(message.sessionId, message.projectId);
    expect(body.events).toHaveLength(200);
  });

  it("exports only an exact null jurisdiction into the default catalog", async () => {
    const defaultProject = makeFinalizeMessage("default-residency");
    const euProject = makeFinalizeMessage("eu-residency");
    const emptyProject = makeFinalizeMessage("empty-residency");
    const unknownProject = makeFinalizeMessage("unknown-residency");
    await seedProject(defaultProject.projectId, null);
    await seedProject(euProject.projectId, "eu");
    await seedProject(emptyProject.projectId, "");
    await seedProject(unknownProject.projectId, "unknown");

    await indexWithWarehouse(defaultProject);
    await indexWithWarehouse(euProject);
    await indexWithWarehouse(emptyProject);
    await indexWithWarehouse(unknownProject);

    expect(
      (await readSession(defaultProject.sessionId, defaultProject.projectId)).outbox,
    ).toHaveLength(3);
    expect((await readSession(euProject.sessionId, euProject.projectId)).outbox).toEqual([]);
    expect((await readSession(emptyProject.sessionId, emptyProject.projectId)).outbox).toEqual([]);
    expect((await readSession(unknownProject.sessionId, unknownProject.projectId)).outbox).toEqual(
      [],
    );
  });

  it("keeps the same session id separate across projects", async () => {
    const sharedSessionId = `shared-${Date.now()}`;
    const first = makeFinalizeMessage("tenant-a", { sessionId: sharedSessionId });
    const second = makeFinalizeMessage("tenant-b", { sessionId: sharedSessionId });

    await sendFinalizeMessage(first);
    await sendFinalizeMessage(second);
    const firstBody = await waitForSession(first.sessionId, first.projectId);
    const secondBody = await waitForSession(second.sessionId, second.projectId);

    expect(firstBody.session?.["project_id"]).toBe(first.projectId);
    expect(secondBody.session?.["project_id"]).toBe(second.projectId);
    expect(firstBody.usage[0]?.["sessions"]).toBe(1);
    expect(secondBody.usage[0]?.["sessions"]).toBe(1);
  }, 30_000);

  it("rolls back the whole index when a later statement fails", async () => {
    const message = makeFinalizeMessage("rollback");
    await failEventInsert(message.sessionId);

    const res = await worker.fetch("/__test/consumer/index-now", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    expect(res.status).toBe(500);

    const body = await readSession(message.sessionId);
    const usage = await readUsage(message.orgId);
    expect(body.session).toBeNull();
    expect(body.events).toEqual([]);
    expect(body.outbox).toEqual([]);
    expect(usage).toEqual([]);
  });

  it("acks an invalid message and keeps the worker healthy", async () => {
    const badSessionId = `bad-${Date.now()}`;

    await sendFinalizeMessage({ type: "session.finalized", sessionId: badSessionId });

    const health = await worker.fetch("/api/v1/health");
    expect(health.status).toBe(200);
    const body = await readSession(badSessionId);
    expect(body.session).toBeNull();
    expect(body.events).toEqual([]);
  });

  it("sweeps expired sessions and leaves live sessions alone", async () => {
    const now = Date.now();
    const expired = makeSessionRow("expired", now - 60_000);
    const live = makeSessionRow("live", now + 60_000);
    const expiredPrefix = sessionPrefix(
      String(expired["project_id"]),
      String(expired["session_id"]),
    );
    const livePrefix = sessionPrefix(String(live["project_id"]), String(live["session_id"]));
    const expiredKeys = [`${expiredPrefix}/manifest.json`, `${expiredPrefix}/seg-000001.ors`];
    const liveKey = `${livePrefix}/manifest.json`;

    await seedSession(expired, expiredKeys, [
      { t: now - 2_000, kind: "error", detail: "old error" },
    ]);
    await seedSession(live, [liveKey], [{ t: now, kind: "custom", detail: "keep me" }]);
    await expectR2Object(expiredKeys[0] ?? "", true);
    await expectR2Object(expiredKeys[1] ?? "", true);
    await expectR2Object(liveKey, true);

    const sweep = await worker.fetch("/__test/consumer/sweep", { method: "POST" });
    expect(sweep.status).toBe(200);

    const expiredBody = await readSession(String(expired["session_id"]));
    expect(expiredBody.session).toBeNull();
    expect(expiredBody.events).toEqual([]);
    await expectR2Object(expiredKeys[0] ?? "", false);
    await expectR2Object(expiredKeys[1] ?? "", false);

    const liveBody = await readSession(String(live["session_id"]));
    expect(liveBody.session?.["session_id"]).toBe(live["session_id"]);
    expect(liveBody.events).toHaveLength(1);
    await expectR2Object(liveKey, true);
  });

  it("sweeps more than one safe D1 delete chunk", async () => {
    const expiresAt = Date.now() - 60_000;
    const expired = Array.from({ length: 51 }, (_, index) =>
      makeSessionRow(`chunk-${index}-${Date.now()}`, expiresAt),
    );

    for (const session of expired) {
      await seedSession(session, [], []);
    }

    const sweep = await worker.fetch("/__test/consumer/sweep", { method: "POST" });
    expect(sweep.status).toBe(200);

    for (const index of [0, 30, 50]) {
      const session = expired[index];
      if (session === undefined) throw new Error("expired test session was not prepared");
      expect((await readSession(String(session["session_id"]))).session).toBeNull();
    }
  }, 60_000);

  it("keeps retry state when a session delete fails after object cleanup", async () => {
    const now = Date.now();
    const expired = makeSessionRow("deletefail", now - 60_000);
    const expiredPrefix = sessionPrefix(
      String(expired["project_id"]),
      String(expired["session_id"]),
    );
    const manifestKey = `${expiredPrefix}/manifest.json`;

    await seedSession(
      expired,
      [manifestKey],
      [{ t: now - 2_000, kind: "error", detail: "keep event" }],
    );
    await expectR2Object(manifestKey, true);
    await failSessionDelete(String(expired["session_id"]));

    const sweep = await worker.fetch("/__test/consumer/sweep", { method: "POST" });
    expect(sweep.status).toBe(500);

    const body = await readSession(String(expired["session_id"]));
    expect(body.session?.["session_id"]).toBe(expired["session_id"]);
    expect(body.events).toHaveLength(1);
    await expectR2Object(manifestKey, false);
  });
});

function makeFinalizeMessage(
  name: string,
  overrides: Partial<Pick<FinalizeMessage, "sessionId">> = {},
): FinalizeMessage {
  const sessionId = overrides.sessionId ?? `session-${name}-${Date.now()}`;
  const projectId = `project-${name}`;
  const orgId = `org-${name}`;
  const startedAt = Date.UTC(2026, 0, 15, 10, 0, 0);
  const endedAt = startedAt + 12_345;

  return {
    type: "session.finalized",
    sessionId,
    projectId,
    orgId,
    shard: 0,
    requestId: `request-${name}`,
    manifestKey: manifestKey(projectId, sessionId),
    startedAt,
    endedAt,
    bytes: 12_345,
    segments: 2,
    flags: 6,
    analyticsVersion: 2,
    insights: {
      maxScrollDepth: 84,
      quickBacks: 2,
      interactionTimeMs: 8_500,
    },
    counts: {
      batches: 3,
      events: 10,
      clicks: 4,
      errors: 1,
      rages: 1,
      navs: 2,
    },
    attrs: {
      country: "US",
      region: "CA",
      city: "San Francisco",
      device: "desktop",
      browser: "Chrome",
      os: "macOS",
      entryUrl: "https://app.example/checkout",
      urlCount: 3,
      pageCount: 3,
    },
    retentionDays: 30,
    events: [
      { t: startedAt + 100, k: "error", d: "e".repeat(200) },
      { t: startedAt + 200, k: "custom", d: "checked out" },
    ],
  };
}

function makeSessionRow(name: string, expiresAt: number): Record<string, unknown> {
  const sessionId = `sweep-${name}-${Date.now()}`;
  const projectId = `sweep-project-${name}`;
  const now = Date.now();

  return {
    session_id: sessionId,
    project_id: projectId,
    org_id: `sweep-org-${name}`,
    started_at: now - 10_000,
    ended_at: now - 1_000,
    duration_ms: 9_000,
    country: "US",
    region: "CA",
    city: "San Francisco",
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    entry_url: "/",
    url_count: 1,
    page_count: null,
    analytics_version: 0,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    clicks: 1,
    errors: 0,
    rages: 0,
    navs: 1,
    bytes: 100,
    segment_count: 1,
    flags: 0,
    manifest_key: manifestKey(projectId, sessionId),
    expires_at: expiresAt,
  };
}

async function sendFinalizeMessage(message: unknown): Promise<void> {
  const res = await worker.fetch("/__test/consumer/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  expect(res.status).toBe(200);
}

async function failEventInsert(sessionId: string): Promise<void> {
  const res = await worker.fetch(
    `/__test/consumer/fail-event-insert?id=${encodeURIComponent(sessionId)}`,
    { method: "POST" },
  );
  expect(res.status).toBe(200);
}

async function failSessionDelete(sessionId: string): Promise<void> {
  const res = await worker.fetch(
    `/__test/consumer/fail-session-delete?id=${encodeURIComponent(sessionId)}`,
    { method: "POST" },
  );
  expect(res.status).toBe(200);
}

async function seedSession(
  session: Record<string, unknown>,
  r2Keys: string[],
  events: Record<string, unknown>[],
): Promise<void> {
  const res = await worker.fetch("/__test/consumer/seed-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, r2Keys, events }),
  });
  expect(res.status).toBe(200);
}

async function seedProject(projectId: string, jurisdiction: string | null): Promise<void> {
  const response = await worker.fetch("/__test/consumer/seed-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, jurisdiction }),
  });
  expect(response.status).toBe(200);
}

async function indexWithWarehouse(message: FinalizeMessage): Promise<void> {
  const response = await worker.fetch("/__test/consumer/index-now?warehouse=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  expect(response.status).toBe(200);
}

async function waitForSession(sessionId: string, projectId?: string): Promise<ConsumerSessionBody> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const body = await readSession(sessionId, projectId);
    if (body.session !== null) return body;
    await delay(pollDelayMs);
  }

  throw new Error(`session ${sessionId} did not appear`);
}

async function waitForStableUsage(sessionId: string): Promise<ConsumerSessionBody> {
  const deadline = Date.now() + 15_000;
  const stableUntil = Date.now() + 1_500;
  let lastBody: ConsumerSessionBody | undefined;

  while (Date.now() < deadline) {
    const body = await readSession(sessionId);
    lastBody = body;
    const sessions = body.usage[0]?.["sessions"];
    if (sessions !== 1) {
      throw new Error(`usage for ${sessionId} changed to ${String(sessions)}`);
    }
    if (Date.now() >= stableUntil) return body;
    await delay(pollDelayMs);
  }

  if (lastBody !== undefined) return lastBody;
  throw new Error(`usage for ${sessionId} was not readable`);
}

async function readSession(sessionId: string, projectId?: string): Promise<ConsumerSessionBody> {
  const url = new URL("/__test/consumer/session", "https://worker.test");
  url.searchParams.set("id", sessionId);
  if (projectId !== undefined) {
    url.searchParams.set("project", projectId);
  }
  const res = await worker.fetch(`${url.pathname}${url.search}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ConsumerSessionBody;
}

async function readUsage(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await worker.fetch(`/__test/consumer/usage?org=${encodeURIComponent(orgId)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { usage: Record<string, unknown>[] };
  return body.usage;
}

async function expectR2Object(key: string, exists: boolean): Promise<void> {
  const res = await worker.fetch(`/__test/consumer/r2?key=${encodeURIComponent(key)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { exists: boolean };
  expect(body.exists).toBe(exists);
}

async function writePresence(
  message: FinalizeMessage,
  route: "/ping" | "/mark-finalizing",
  extra: Record<string, unknown>,
): Promise<void> {
  const response = await worker.fetch(`/__test/do/presence${route}`, {
    method: "POST",
    body: JSON.stringify({
      projectId: message.projectId,
      sessionId: message.sessionId,
      ...extra,
    }),
  });
  expect(response.status).toBe(200);
}

async function readPresenceHeads(
  message: FinalizeMessage,
): Promise<{ sessions: Array<{ session_id: string; activity: string }> }> {
  const response = await worker.fetch("/__test/do/presence/heads", {
    method: "POST",
    body: JSON.stringify({ projectId: message.projectId, now: Date.now() }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    sessions: Array<{ session_id: string; activity: string }>;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
