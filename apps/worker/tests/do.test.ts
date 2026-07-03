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
      bufferedBytes: payloadA.byteLength + payloadB.byteLength + payloadC.byteLength,
      pendingBatches: 3,
      segmentCount: 0,
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

  it("finalizes an idle session into a manifest", async () => {
    const projectId = "project-finalize";
    const sessionId = "session-finalize";
    const payload = bytes("finalize-payload");

    await append({
      projectId,
      sessionId,
      tab: "tab-a",
      seq: 0,
      payload,
      t0: 3000,
      events: [
        { t: 3010, k: "click" },
        { t: 3020, k: "error", d: "failed" },
        { t: 3030, k: "custom", d: "checkout" },
        { t: 3040, k: "nav" },
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
        t0: 3000,
        t1: 3050,
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
});

interface AppendInput {
  projectId: string;
  sessionId: string;
  tab: string;
  seq: number;
  payload: Uint8Array;
  t0: number;
  events?: BatchIndex["e"];
}

interface DebugBody {
  hasState: boolean;
  bufferedBytes: number;
  pendingBatches: number;
  segmentCount: number;
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
    t1: input.t0 + 50,
    u: `/page-${input.seq}`,
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
      attrs: { country: "US" },
      receivedAt: Date.now(),
    }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as AppendResultBody;
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

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
