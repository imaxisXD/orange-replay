import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { manifestKey, parseSegment, segmentBatch, segmentKey } from "@orange-replay/shared";
import type { BatchIndex, SessionManifest } from "@orange-replay/shared";
import { unstable_dev } from "wrangler";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const timing = {
  segmentFlushMs: 500,
  flushTailMs: 700,
  closeMs: 1500,
  segmentFlushBytes: 4096,
  presenceTtlMs: 300,
  presenceHeartbeatMs: 200,
};

let worker: Awaited<ReturnType<typeof unstable_dev>>;

beforeAll(async () => {
  worker = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: {
      DEV_TEST_ROUTES: "1",
      TEST_TIMINGS: JSON.stringify(timing),
    },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
});

describe("SessionRecorder Durable Object", () => {
  it("dedupes batches by tab and seq", async () => {
    const projectId = "project-dedupe";
    const sessionId = "session-dedupe";
    const payloadA = bytes("payload-a");
    const payloadB = bytes("payload-b");
    const payloadC = bytes("payload-c");

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload: payloadA, t0: 1000 });
    await append({ projectId, sessionId, tab: "tab-b", seq: 0, payload: payloadB, t0: 1100 });
    await append({ projectId, sessionId, tab: "tab-a", seq: 1, payload: payloadC, t0: 1200 });
    await append({ projectId, sessionId, tab: "tab-a", seq: 1, payload: payloadC, t0: 1200 });

    const debug = await readDebug(projectId, sessionId);

    expect(debug).toEqual({
      hasState: true,
      finalized: false,
      bufferedBytes: payloadA.byteLength + payloadB.byteLength + payloadC.byteLength,
      pendingBatches: 3,
      segmentCount: 0,
      stateBytes: expect.any(Number),
    });
  });

  it("flushes a segment when buffered bytes exceed the limit", async () => {
    const projectId = "project-size-flush";
    const sessionId = "session-size-flush";
    const payload = randomBytes(5000);

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload, t0: 2000 });

    const debug = await readDebug(projectId, sessionId);
    expect(debug.bufferedBytes).toBe(0);
    expect(debug.pendingBatches).toBe(0);
    expect(debug.segmentCount).toBe(1);

    const segmentBytes = await readR2Bytes(segmentKey(projectId, sessionId, 1));
    const parsed = parseSegment(segmentBytes);

    expect(parsed.count).toBe(1);
    expect(Buffer.from(segmentBatch(parsed, 0))).toEqual(payload);
  });

  it("dedupes an already flushed batch for the whole session", async () => {
    const projectId = "project-flushed-dedupe";
    const sessionId = "session-flushed-dedupe";
    const batches: AppendInput[] = [
      {
        projectId,
        sessionId,
        tab: "tab-a",
        seq: 0,
        payload: randomBytes(1500),
        t0: 2500,
        events: [{ t: 2501, k: "custom", d: "unique-0" }],
      },
      {
        projectId,
        sessionId,
        tab: "tab-a",
        seq: 1,
        payload: randomBytes(1500),
        t0: 2600,
        events: [{ t: 2601, k: "custom", d: "unique-1" }],
      },
      {
        projectId,
        sessionId,
        tab: "tab-b",
        seq: 0,
        payload: randomBytes(1500),
        t0: 2700,
        events: [{ t: 2701, k: "custom", d: "unique-2" }],
      },
    ];

    for (const batch of batches) {
      await append(batch);
    }

    const afterFlush = await readDebug(projectId, sessionId);
    expect(afterFlush.bufferedBytes).toBe(0);
    expect(afterFlush.pendingBatches).toBe(0);
    expect(afterFlush.segmentCount).toBe(1);

    const duplicate = batches[1];
    if (duplicate === undefined) {
      throw new Error("duplicate batch was not prepared");
    }

    await append(duplicate);

    const afterDuplicate = await readDebug(projectId, sessionId);
    expect(afterDuplicate.pendingBatches).toBe(afterFlush.pendingBatches);
    expect(afterDuplicate.bufferedBytes).toBe(afterFlush.bufferedBytes);
    expect(afterDuplicate.segmentCount).toBe(afterFlush.segmentCount);

    const manifestBytes = await waitForR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;

    expect(manifest.counts.batches).toBe(batches.length);
    expect(manifest.counts.events).toBe(batches.length);
    expect(manifest.timeline.map((event) => event.d)).toEqual(["unique-0", "unique-1", "unique-2"]);
  });

  it("finalizes an idle session into a manifest", async () => {
    const projectId = "project-finalize";
    const sessionId = "session-finalize";
    const payload = bytes("finalize-payload");
    // Timestamps must sit inside the server clamp window (A5), or they get
    // clamped to receive time and exact assertions break.
    const base = Date.now();

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload,
      t0: base,
      events: [
        { t: base + 10, k: "click" },
        { t: base + 20, k: "error", d: "failed" },
        { t: base + 30, k: "custom", d: "checkout" },
        { t: base + 40, k: "nav" },
      ],
    });

    const manifestBytes = await waitForR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;
    const debug = await readDebug(projectId, sessionId);

    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.projectId).toBe(projectId);
    expect(manifest.segments).toEqual([
      {
        key: segmentKey(projectId, sessionId, 1),
        bytes: expect.any(Number),
        t0: base,
        t1: base + 50,
        batches: 1,
      },
    ]);
    expect(manifest.counts).toEqual({
      batches: 1,
      events: 4,
      clicks: 1,
      errors: 1,
      rages: 0,
      navs: 1,
    });
    expect(manifest.timeline.map((event) => event.k)).toEqual(["click", "error", "custom", "nav"]);
    expect(debug.hasState).toBe(false);
    expect(debug.finalized).toBe(true);
  });

  it("returns closed for a late post-finalize batch", async () => {
    const projectId = "project-finalize";
    const sessionId = "session-finalize";

    const result = await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: bytes("late"),
      t0: 4000,
    });

    expect(result.closed).toBe(true);
    expect(result.live).toBe(false);
  });

  it("does not let a late seq-zero batch overwrite finalized R2 objects", async () => {
    const projectId = "project-finalize-immutable";
    const sessionId = "session-finalize-immutable";
    const payload = randomBytes(5000);

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload, t0: 4100 });
    await forceFinalize(projectId, sessionId);

    const segmentBefore = await readR2Bytes(segmentKey(projectId, sessionId, 1));
    const manifestBefore = await readR2Bytes(manifestKey(projectId, sessionId));
    const result = await append({
      projectId,
      sessionId,
      tab: "tab-late",
      seq: 0,
      payload: randomBytes(6000),
      t0: 4200,
    });
    const segmentAfter = await readR2Bytes(segmentKey(projectId, sessionId, 1));
    const manifestAfter = await readR2Bytes(manifestKey(projectId, sessionId));

    expect(result.closed).toBe(true);
    expect(Buffer.from(segmentAfter)).toEqual(Buffer.from(segmentBefore));
    expect(Buffer.from(manifestAfter)).toEqual(Buffer.from(manifestBefore));
  });

  it("purges the finalized tombstone after the purge alarm", async () => {
    const projectId = "project-tombstone-purge";
    const sessionId = "session-tombstone-purge";

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("purge"),
      t0: 4300,
    });
    await forceFinalize(projectId, sessionId);

    const finalizedDebug = await readDebug(projectId, sessionId);
    expect(finalizedDebug.finalized).toBe(true);

    const purgedDebug = await pollDebug(projectId, sessionId, (body) => !body.finalized, 10_000);
    expect(purgedDebug.hasState).toBe(false);
    expect(purgedDebug.finalized).toBe(false);
  }, 15_000);

  it("keeps gzip-like payload bytes unchanged", async () => {
    const projectId = "project-exact-bytes";
    const sessionId = "session-exact-bytes";
    const payload = randomBytes(6000);
    payload[0] = 0x1f;
    payload[1] = 0x8b;

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload, t0: 5000 });

    const segmentBytes = await readR2Bytes(segmentKey(projectId, sessionId, 1));
    const parsed = parseSegment(segmentBytes);

    expect(Buffer.from(segmentBatch(parsed, 0))).toEqual(payload);
  });

  it("skips empty stored bodies so a poison row cannot wedge finalize", async () => {
    const projectId = "project-empty-poison";
    const sessionId = "session-empty-poison";
    const payload = bytes("valid-after-empty");

    await seedBatches({
      projectId,
      sessionId,
      tab: "tab-a",
      startSeq: 0,
      count: 1,
      payloadBytes: 0,
      t0: 6000,
    });
    await append({ projectId, sessionId, tab: "tab-a", seq: 1, payload, t0: 6010 });

    const manifestBytes = await waitForR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;
    const parsed = parseSegment(await readR2Bytes(segmentKey(projectId, sessionId, 1)));

    expect(manifest.counts.batches).toBe(1);
    expect(parsed.count).toBe(1);
    // hex-normalize: Buffer vs Uint8Array are structurally unequal to toEqual
    expect(Buffer.from(segmentBatch(parsed, 0)).toString("hex")).toBe(
      Buffer.from(payload).toString("hex"),
    );
  });

  it("flushes more than one max-sized chunk in a single snapshot", async () => {
    const projectId = "project-multi-chunk";
    const sessionId = "session-multi-chunk";
    const batchCount = 4097;

    await seedBatches({
      projectId,
      sessionId,
      tab: "tab-a",
      startSeq: 0,
      count: batchCount,
      payloadBytes: 1,
      t0: 7000,
    });
    const flushResult = await flush(projectId, sessionId);

    expect(flushResult?.batches).toBe(batchCount);

    const first = parseSegment(await readR2Bytes(segmentKey(projectId, sessionId, 1)));
    const second = parseSegment(await readR2Bytes(segmentKey(projectId, sessionId, 2)));
    const payloadValues: number[] = [];
    for (let index = 0; index < first.count; index += 1) {
      payloadValues.push(segmentBatch(first, index)[0] ?? 0);
    }
    for (let index = 0; index < second.count; index += 1) {
      payloadValues.push(segmentBatch(second, index)[0] ?? 0);
    }

    expect(first.count).toBe(4096);
    expect(second.count).toBe(1);
    expect(payloadValues).toEqual(
      Array.from({ length: batchCount }, (_, index) => (index % 251) + 1),
    );
  });

  it("uses server receive time for session bounds when client time is far in the future", async () => {
    const projectId = "project-server-time";
    const sessionId = "session-server-time";
    const receivedAt = Date.now();

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("future-time"),
      t0: receivedAt,
      t1: receivedAt + 5 * 365 * 24 * 60 * 60 * 1000,
      receivedAt,
    });
    await forceFinalize(projectId, sessionId);

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;

    expect(manifest.startedAt).toBe(receivedAt);
    expect(manifest.endedAt).toBeLessThanOrEqual(receivedAt + 60_000);
    expect(manifest.durationMs).toBeGreaterThanOrEqual(0);
    expect(manifest.durationMs).toBeLessThanOrEqual(60_000);
  });

  it("does not lose a batch that races with finalize", async () => {
    const projectId = "project-finalize-race";
    const sessionId = "session-finalize-race";
    const firstPayload = bytes("first");
    const racePayload = bytes("race");

    await append({ projectId, sessionId, tab: "tab-a", seq: 0, payload: firstPayload, t0: 8000 });
    const finalizePromise = forceFinalize(projectId, sessionId);
    const appendPromise = append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: racePayload,
      t0: 8010,
    });
    const appendResult = await appendPromise;
    await finalizePromise;

    const manifestBytes = await readR2Bytes(manifestKey(projectId, sessionId));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SessionManifest;
    const payloads = await readManifestPayloads(manifest);

    if (appendResult.closed) {
      expect(payloads).not.toContain(Buffer.from(racePayload).toString("hex"));
    } else {
      expect(payloads).toContain(Buffer.from(racePayload).toString("hex"));
    }
  });

  it("keeps state small when many navigations are recorded", async () => {
    const projectId = "project-small-state";
    const sessionId = "session-small-state";

    const debug = await seedBatches({
      projectId,
      sessionId,
      tab: "tab-a",
      startSeq: 0,
      count: 1500,
      payloadBytes: 0,
      t0: 9000,
    });

    expect(debug.hasState).toBe(true);
    expect(debug.stateBytes).toBeLessThan(1000);
  });

  it("pings presence on start and throttles heartbeat updates", async () => {
    const projectId = "project-presence-heartbeat";
    const sessionId = "session-presence-heartbeat";
    const startedAt = Date.now();

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("presence-start"),
      t0: startedAt,
      receivedAt: startedAt,
      url: "/start",
      attrs: {
        country: "US",
        city: "Austin",
        browser: "Chrome",
        os: "macOS",
        device: "desktop",
      },
    });

    const firstList = await pollPresenceList(
      projectId,
      (body) => body.sessions.length === 1,
      startedAt + 10,
    );
    expect(firstList.sessions[0]).toMatchObject({
      session_id: sessionId,
      started_at: startedAt,
      last_seen: startedAt,
      entry_url: "/start",
      country: "US",
      city: "Austin",
      browser: "Chrome",
      os: "macOS",
      device: "desktop",
    });

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 1,
      payload: bytes("presence-too-soon"),
      t0: startedAt + 50,
      receivedAt: startedAt + 50,
    });
    const throttledList = await readPresenceList(projectId, startedAt + 60);
    expect(throttledList.sessions[0]?.last_seen).toBe(startedAt);

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 2,
      payload: bytes("presence-heartbeat"),
      t0: startedAt + 250,
      receivedAt: startedAt + 250,
    });
    const heartbeatList = await pollPresenceList(
      projectId,
      (body) => body.sessions[0]?.last_seen === startedAt + 250,
      startedAt + 260,
    );
    expect(heartbeatList.sessions[0]?.last_seen).toBe(startedAt + 250);
  });

  it("removes presence on finalize", async () => {
    const projectId = "project-presence-remove";
    const sessionId = "session-presence-remove";

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload: bytes("presence-remove"),
      t0: Date.now(),
    });
    await pollPresenceList(projectId, (body) => body.sessions.length === 1);
    await forceFinalize(projectId, sessionId);

    const removed = await pollPresenceList(projectId, (body) => body.sessions.length === 0);
    expect(removed.sessions).toEqual([]);
  });

  it("uses lazy TTL eviction and keeps duplicate pings and removes safe", async () => {
    const projectId = "project-presence-ttl";
    const sessionId = "session-presence-ttl";

    await presencePing({
      projectId,
      sessionId,
      startedAt: 1000,
      lastSeen: 1000,
      entryUrl: "/old",
    });
    await presencePing({
      projectId,
      sessionId,
      startedAt: 1000,
      lastSeen: 1000,
      entryUrl: "/old",
    });

    const active = await readPresenceList(projectId, 1200);
    expect(active.sessions.map((session) => session.session_id)).toEqual([sessionId]);

    const stale = await readPresenceList(projectId, 1401);
    expect(stale.sessions).toEqual([]);
    expect(await readPresenceDebug(projectId)).toMatchObject({ rows: 0 });

    await presenceRemove(projectId, sessionId);
    await presenceRemove(projectId, sessionId);
    expect(await readPresenceDebug(projectId)).toMatchObject({ rows: 0 });
  });

  it("sets install status only on the first presence ping", async () => {
    const projectId = "project-install-status";

    expect(await readPresenceInstallStatus(projectId)).toEqual({ firstEventAt: null });

    await presencePing({
      projectId,
      sessionId: "session-install-a",
      startedAt: 2000,
      lastSeen: 2000,
      entryUrl: "/first",
    });
    expect(await readPresenceInstallStatus(projectId)).toEqual({ firstEventAt: 2000 });

    await presencePing({
      projectId,
      sessionId: "session-install-b",
      startedAt: 3000,
      lastSeen: 3000,
      entryUrl: "/second",
    });
    expect(await readPresenceInstallStatus(projectId)).toEqual({ firstEventAt: 2000 });
  });
});

interface AppendInput {
  projectId: string;
  sessionId: string;
  tab: string;
  seq: number;
  payload: Uint8Array;
  t0: number;
  t1?: number;
  receivedAt?: number;
  url?: string;
  events?: BatchIndex["e"];
  attrs?: Record<string, string | number>;
}

interface DebugBody {
  hasState: boolean;
  finalized: boolean;
  bufferedBytes: number;
  pendingBatches: number;
  segmentCount: number;
  stateBytes: number;
  tombstonePurgeAt?: number;
}

interface AppendResultBody {
  live: boolean;
  closed: boolean;
  flushMs: number;
}

async function append(input: AppendInput): Promise<AppendResultBody> {
  const index: BatchIndex = {
    v: 1,
    s: input.sessionId,
    tab: input.tab,
    seq: input.seq,
    t0: input.t0,
    t1: input.t1 ?? input.t0 + 50,
    u: input.url ?? `/page-${input.seq}`,
    e: input.events ?? [{ t: input.t0 + 1, k: "custom", d: `batch-${input.seq}` }],
  };
  const response = await worker.fetch("/__test/do/append", {
    method: "POST",
    body: JSON.stringify({
      projectId: input.projectId,
      orgId: "org",
      shard: 0,
      retentionDays: 7,
      requestId: `req-${input.projectId}-${input.sessionId}-${input.tab}-${input.seq}`,
      sessionId: input.sessionId,
      tab: input.tab,
      seq: input.seq,
      flags: 0,
      index,
      payloadB64: Buffer.from(input.payload).toString("base64"),
      attrs: input.attrs ?? { country: "US" },
      receivedAt: input.receivedAt ?? Date.now(),
    }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as AppendResultBody;
}

async function seedBatches(input: {
  projectId: string;
  sessionId: string;
  tab: string;
  startSeq: number;
  count: number;
  payloadBytes: number;
  t0: number;
}): Promise<DebugBody> {
  const response = await worker.fetch("/__test/do/seed-batches", {
    method: "POST",
    body: JSON.stringify({
      requestId: `req-${input.projectId}-${input.sessionId}-seed`,
      projectId: input.projectId,
      orgId: "org",
      shard: 0,
      retentionDays: 7,
      sessionId: input.sessionId,
      tab: input.tab,
      startSeq: input.startSeq,
      count: input.count,
      payloadBytes: input.payloadBytes,
      t0: input.t0,
      receivedAt: Date.now(),
      flags: 0,
      attrs: { country: "US" },
    }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as DebugBody;
}

async function flush(
  projectId: string,
  sessionId: string,
): Promise<{ reason: string; bytes: number; batches: number } | null> {
  const response = await worker.fetch("/__test/do/flush", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as { reason: string; bytes: number; batches: number } | null;
}

async function forceFinalize(projectId: string, sessionId: string): Promise<void> {
  const response = await worker.fetch("/__test/do/finalize", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId }),
  });

  expect(response.status).toBe(200);
}

async function readDebug(projectId: string, sessionId: string): Promise<DebugBody> {
  const response = await worker.fetch(
    `/__test/do/debug?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
  );

  expect(response.status).toBe(200);
  return (await response.json()) as DebugBody;
}

async function readR2Bytes(key: string): Promise<Uint8Array> {
  const response = await worker.fetch(`/__test/do/r2?key=${encodeURIComponent(key)}`);

  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

async function waitForR2Bytes(key: string): Promise<Uint8Array> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 6000) {
    const response = await worker.fetch(`/__test/do/r2?key=${encodeURIComponent(key)}`);
    if (response.status === 200) {
      return new Uint8Array(await response.arrayBuffer());
    }
    await sleep(100);
  }

  throw new Error(`R2 object was not written: ${key}`);
}

async function pollDebug(
  projectId: string,
  sessionId: string,
  ready: (body: DebugBody) => boolean,
  deadlineMs: number,
): Promise<DebugBody> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    const body = await readDebug(projectId, sessionId);
    if (ready(body)) {
      return body;
    }
    await sleep(100);
  }

  throw new Error(`debug state did not match within ${deadlineMs}ms`);
}

async function readManifestPayloads(manifest: SessionManifest): Promise<string[]> {
  const payloads: string[] = [];
  for (const segment of manifest.segments) {
    const parsed = parseSegment(await readR2Bytes(segment.key));
    for (let index = 0; index < parsed.count; index += 1) {
      payloads.push(Buffer.from(segmentBatch(parsed, index)).toString("hex"));
    }
  }
  return payloads;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface PresenceListBody {
  sessions: Array<{
    session_id: string;
    started_at: number;
    last_seen: number;
    entry_url: string | null;
    country: string | null;
    city: string | null;
    browser: string | null;
    os: string | null;
    device: string | null;
  }>;
}

async function presencePing(input: {
  projectId: string;
  sessionId: string;
  startedAt: number;
  lastSeen: number;
  entryUrl: string;
}): Promise<void> {
  const response = await worker.fetch("/__test/do/presence/ping", {
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

  expect(response.status).toBe(200);
}

async function presenceRemove(projectId: string, sessionId: string): Promise<void> {
  const response = await worker.fetch("/__test/do/presence/remove", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId }),
  });

  expect(response.status).toBe(200);
}

async function readPresenceList(projectId: string, now = Date.now()): Promise<PresenceListBody> {
  const response = await worker.fetch("/__test/do/presence/list", {
    method: "POST",
    body: JSON.stringify({ projectId, now }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as PresenceListBody;
}

async function readPresenceDebug(
  projectId: string,
): Promise<{ rows: number; firstEventAt: number | null }> {
  const response = await worker.fetch("/__test/do/presence/debug", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as { rows: number; firstEventAt: number | null };
}

async function readPresenceInstallStatus(
  projectId: string,
): Promise<{ firstEventAt: number | null }> {
  const response = await worker.fetch("/__test/do/presence/install-status", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as { firstEventAt: number | null };
}

async function pollPresenceList(
  projectId: string,
  ready: (body: PresenceListBody) => boolean,
  now = Date.now(),
): Promise<PresenceListBody> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3000) {
    const body = await readPresenceList(projectId, now);
    if (ready(body)) {
      return body;
    }
    await sleep(50);
  }

  throw new Error("presence list did not match within 3000ms");
}
