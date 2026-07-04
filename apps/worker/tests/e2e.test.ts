import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  decodeIngestBody,
  encodeIngestBody,
  HDR_FLAGS,
  HDR_KEY,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  manifestKey,
  parseSegment,
  segmentBatch,
} from "@orange-replay/shared";
import type { BatchIndex, IngestAck, ProjectConfig, SessionManifest } from "@orange-replay/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { unstable_dev } from "wrangler";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const timings = {
  segmentFlushMs: 600,
  segmentFlushBytes: 2048,
  flushTailMs: 800,
  closeMs: 2500,
};
const pollIntervalMs = 250;
const dayMs = 86_400_000;
const apiToken = "e2e-token";
const ingestKey = "or_e2e_key";
const projectId = "pe2e";
const orgId = "oe2e";
const sessionId = "sess-e2e-000000000001";
const liveSessionId = "sess-e2e-live-00000001";
const hostileSessionId = "sess-e2e-hostile-0001";
// Inside the A5 server clamp window so exact timeline assertions hold.
const hostileBase = Date.now();

let worker: Awaited<ReturnType<typeof unstable_dev>>;
let sentBatches: SentBatch[] = [];
let r2Manifest: SessionManifest | undefined;
let indexedSession: ConsumerSessionBody | undefined;

beforeAll(async () => {
  worker = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: {
      DEV_TEST_ROUTES: "1",
      DEV_API_TOKEN: apiToken,
      TEST_TIMINGS: JSON.stringify(timings),
    },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });
}, 120_000);

afterAll(async () => {
  await worker?.stop();
});

describe("a session lives and is replayed", () => {
  it("seeds a project", async () => {
    const res = await worker.fetch("/__test/ingest/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: ingestKey,
        kv: true,
        config: makeProjectConfig(),
      }),
    });

    expect(res.status).toBe(200);
  }, 30_000);

  it("records batches and accepts an idempotent duplicate", async () => {
    sentBatches = makeRecordedBatches();

    for (const batch of sentBatches) {
      const res = await postIngest(batch);
      expect(res.status).toBe(200);
      expect((await res.json()) as IngestAck).toMatchObject({ ok: true });
    }

    const duplicate = sentBatches.find((batch) => batch.tab === "tabA" && batch.seq === 1);
    if (duplicate === undefined) {
      throw new Error("duplicate batch was not prepared");
    }

    const duplicateRes = await postIngest(duplicate);
    expect(duplicateRes.status).toBe(200);
    expect((await duplicateRes.json()) as IngestAck).toMatchObject({ ok: true });
  }, 30_000);

  it("flushes at least one segment", async () => {
    const debug = await poll(async () => {
      const body = await readDebug(sessionId);
      return body.segmentCount >= 1 ? body : null;
    }, 10_000);

    expect(debug.segmentCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("finalizes the session into R2", async () => {
    await delay(timings.closeMs + 600);

    await poll(async () => {
      const body = await readDebug(sessionId);
      return body.hasState === false ? body : null;
    }, 15_000);

    r2Manifest = await readR2Json<SessionManifest>(manifestKey(projectId, sessionId));

    expect(r2Manifest.segments.length).toBeGreaterThanOrEqual(1);
    expect(r2Manifest.counts.clicks).toBe(3);
    expect(r2Manifest.counts.errors).toBe(1);
    expect(r2Manifest.counts.batches).toBe(5);
    expect(r2Manifest.timeline.map((event) => event.t)).toEqual(
      r2Manifest.timeline.map((event) => event.t).sort((left, right) => left - right),
    );
    // manifest.bytes is STORED bytes (segments incl. ORS1 headers) — the
    // billing-honest metric — not raw payload bytes.
    const segmentBytesTotal = r2Manifest.segments.reduce((total, seg) => total + seg.bytes, 0);
    expect(r2Manifest.bytes).toBe(segmentBytesTotal);
    expect(r2Manifest.bytes).toBeGreaterThanOrEqual(uniquePayloadBytes());
  }, 30_000);

  it("indexes the finalized session", async () => {
    const manifest = requireManifest();
    indexedSession = await poll(async () => {
      const body = await readConsumerSession(sessionId);
      return body.session === null ? null : body;
    }, 20_000);

    const session = indexedSession.session;
    expect(session?.["session_id"]).toBe(sessionId);
    expect(session?.["clicks"]).toBe(3);
    expect(session?.["errors"]).toBe(1);
    expect(session?.["expires_at"]).toBe(manifest.endedAt + 30 * dayMs);
    expect(indexedSession.usage[0]?.["sessions"]).toBe(1);

    const indexedEvents = indexedSession.events.map((event) => ({
      kind: event["kind"],
      detail: event["detail"],
    }));
    expect(indexedEvents).toEqual(
      expect.arrayContaining([
        { kind: "error", detail: "TypeError: boom" },
        { kind: "custom", detail: "checkout:coupon-applied" },
      ]),
    );
  }, 30_000);

  it("replays the session through the public API", async () => {
    const manifest = requireManifest();
    const manifestRes = await worker.fetch(
      `/api/v1/projects/${projectId}/sessions/${sessionId}/manifest`,
      { headers: authHeaders() },
    );

    expect(manifestRes.status).toBe(200);
    expect((await manifestRes.json()) as SessionManifest).toEqual(manifest);

    const expectedPayloads = new Set(sentBatches.map((batch) => hex(batch.payload)));
    const seenPayloads = new Set<string>();
    let extractedBatchCount = 0;

    for (const segment of manifest.segments) {
      const segmentName = lastPathPart(segment.key);
      const segmentRes = await worker.fetch(
        `/api/v1/projects/${projectId}/sessions/${sessionId}/segments/${segmentName}`,
        { headers: authHeaders() },
      );

      expect(segmentRes.status).toBe(200);
      expect(segmentRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const parsed = parseSegment(new Uint8Array(await segmentRes.arrayBuffer()));
      for (let index = 0; index < parsed.count; index += 1) {
        const payloadHex = hex(segmentBatch(parsed, index));
        expect(expectedPayloads.has(payloadHex)).toBe(true);
        seenPayloads.add(payloadHex);
        extractedBatchCount += 1;
      }
    }

    expect(extractedBatchCount).toBe(sentBatches.length);
    expect(seenPayloads).toEqual(expectedPayloads);
  }, 30_000);

  it("accepts a hostile sidecar after sanitizing events", async () => {
    const batch = makeHostileBatch();
    const res = await postIngest(batch);
    expect(res.status).toBe(200);

    await delay(timings.closeMs + 600);
    const manifest = await poll(async () => {
      const response = await worker.fetch(
        `/__test/do/r2?key=${encodeURIComponent(manifestKey(projectId, hostileSessionId))}`,
      );
      if (response.status !== 200) return null;
      return (await response.json()) as SessionManifest;
    }, 15_000);
    const indexed = await poll(async () => {
      const body = await readConsumerSession(hostileSessionId);
      return body.session === null ? null : body;
    }, 20_000);

    expect(indexed.session?.["session_id"]).toBe(hostileSessionId);
    expect(manifest.timeline).toEqual([
      { t: hostileBase + 10, k: "error", d: "E".repeat(200), m: { code: "E_BAD", count: 1 } },
      { t: hostileBase + 20, k: "custom", d: "ok" },
      { t: hostileBase + 30, k: "custom", d: "deep-meta" },
    ]);
    expect(indexed.events.map((event) => event["kind"])).toEqual(["error", "custom", "custom"]);
  }, 45_000);

  it("streams live batches over the public WebSocket route", async () => {
    const first = makeLiveBatch(0);
    const firstRes = await postIngest(first);
    expect(firstRes.status).toBe(200);

    const conn = openLiveSocket(liveSessionId);
    try {
      const helloMessage = await waitForSocketMessage(conn, "hello", 5_000);
      const hello = parseTextMessage<{ type: string; sessionId: string }>(helloMessage);
      expect(hello.type).toBe("hello");
      expect(hello.sessionId).toBe(liveSessionId);

      const second = makeLiveBatch(1);
      const secondRes = await postIngest(second);
      expect(secondRes.status).toBe(200);
      expect((await secondRes.json()) as IngestAck).toMatchObject({ ok: true, live: true });

      const frame = await waitForSocketMessage(conn, "binary batch", 5_000);
      const decoded = decodeIngestBody(await toBytes(frame));
      expect(decoded.index.seq).toBe(1);
      expect(decoded.index.s).toBe(liveSessionId);
      expect(hex(decoded.payload)).toBe(hex(second.payload));
    } finally {
      conn.socket.close();
    }
  }, 30_000);
});

interface SentBatch {
  sessionId: string;
  tab: string;
  seq: number;
  index: BatchIndex;
  payload: Uint8Array;
  body: Uint8Array;
}

interface DebugBody {
  hasState: boolean;
  bufferedBytes: number;
  pendingBatches: number;
  segmentCount: number;
}

interface ConsumerSessionBody {
  session: Record<string, unknown> | null;
  events: Record<string, unknown>[];
  usage: Record<string, unknown>[];
}

interface LiveSocket {
  binaryType: string;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

interface LiveSocketConstructor {
  new (url: string): LiveSocket;
}

function makeProjectConfig(): ProjectConfig {
  return {
    projectId,
    orgId,
    shard: 0,
    active: true,
    sampleRate: 1,
    allowedOrigins: ["*"],
    maskPolicyVersion: 1,
    quotaState: "ok",
    retentionDays: 30,
  };
}

function makeRecordedBatches(): SentBatch[] {
  return [
    makeBatch({
      sessionId,
      tab: "tabA",
      seq: 0,
      t0: 1_000,
      size: 430,
      url: "/checkout",
      events: [
        { t: 1_010, k: "nav", d: "/checkout" },
        { t: 1_020, k: "click", d: "button[data-checkout-start]" },
      ],
    }),
    makeBatch({
      sessionId,
      tab: "tabB",
      seq: 0,
      t0: 1_100,
      size: 510,
      url: "/checkout/shipping",
      events: [{ t: 1_120, k: "click", d: "input[name='address']" }],
    }),
    makeBatch({
      sessionId,
      tab: "tabA",
      seq: 1,
      t0: 1_200,
      size: 620,
      url: "/checkout/payment",
      events: [{ t: 1_230, k: "error", d: "TypeError: boom" }],
    }),
    makeBatch({
      sessionId,
      tab: "tabB",
      seq: 1,
      t0: 1_300,
      size: 440,
      url: "/checkout/payment",
      events: [{ t: 1_340, k: "custom", d: "checkout:coupon-applied" }],
    }),
    makeBatch({
      sessionId,
      tab: "tabA",
      seq: 2,
      t0: 1_400,
      size: 560,
      url: "/checkout/review",
      events: [{ t: 1_420, k: "click", d: "button[data-place-order]" }],
    }),
  ];
}

function makeLiveBatch(seq: number): SentBatch {
  return makeBatch({
    sessionId: liveSessionId,
    tab: "liveTab",
    seq,
    t0: 5_000 + seq * 100,
    size: 512,
    url: `/live/${seq}`,
    events: [{ t: 5_010 + seq * 100, k: "custom", d: `live-${seq}` }],
  });
}

function makeHostileBatch(): SentBatch {
  const payload = randomBytes(512);
  const index = {
    v: 1,
    s: hostileSessionId,
    tab: "hostileTab",
    seq: 0,
    t0: hostileBase,
    t1: hostileBase + 100,
    e: [
      { t: hostileBase + 10, k: "error", d: "E".repeat(260), m: { code: "E_BAD", count: 1 } },
      { t: hostileBase + 20, k: "custom", d: "ok", m: { nested: { no: true } } },
      { t: hostileBase + 25, k: "wrong-kind", d: "drop" },
      { t: hostileBase + 30, k: "custom", d: "deep-meta", m: { nested: { no: true } } },
      ...Array.from({ length: 10_000 }, () => 0),
    ],
  } as BatchIndex;

  return {
    sessionId: hostileSessionId,
    tab: "hostileTab",
    seq: 0,
    index,
    payload,
    body: encodeIngestBody(index, payload),
  };
}

function makeBatch(input: {
  sessionId: string;
  tab: string;
  seq: number;
  t0: number;
  size: number;
  url: string;
  events: BatchIndex["e"];
}): SentBatch {
  const payload = randomBytes(input.size);
  const index: BatchIndex = {
    v: 1,
    s: input.sessionId,
    tab: input.tab,
    seq: input.seq,
    t0: input.t0,
    t1: input.t0 + 70,
    u: input.url,
    e: input.events,
  };

  return {
    sessionId: input.sessionId,
    tab: input.tab,
    seq: input.seq,
    index,
    payload,
    body: encodeIngestBody(index, payload),
  };
}

async function postIngest(batch: SentBatch): Promise<Response> {
  return worker.fetch("/v1/ingest", {
    method: "POST",
    headers: {
      [HDR_KEY]: ingestKey,
      [HDR_SESSION]: batch.sessionId,
      [HDR_TAB]: batch.tab,
      [HDR_SEQ]: String(batch.seq),
      [HDR_FLAGS]: "0",
      "content-type": "application/octet-stream",
    },
    body: batch.body,
  });
}

async function readDebug(targetSessionId: string): Promise<DebugBody> {
  const res = await worker.fetch(
    `/__test/do/debug?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(targetSessionId)}`,
  );

  expect(res.status).toBe(200);
  return (await res.json()) as DebugBody;
}

async function readR2Json<T>(key: string): Promise<T> {
  const res = await worker.fetch(`/__test/do/r2?key=${encodeURIComponent(key)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function readConsumerSession(targetSessionId: string): Promise<ConsumerSessionBody> {
  const res = await worker.fetch(
    `/__test/consumer/session?id=${encodeURIComponent(targetSessionId)}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ConsumerSessionBody;
}

function requireManifest(): SessionManifest {
  if (r2Manifest === undefined) {
    throw new Error("manifest was not loaded");
  }
  return r2Manifest;
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${apiToken}` };
}

async function poll<T>(fn: () => Promise<T | null>, deadlineMs: number): Promise<T> {
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await delay(pollIntervalMs);
  }

  throw new Error(`condition was not met within ${deadlineMs}ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function uniquePayloadBytes(): number {
  return sentBatches.reduce((total, batch) => total + batch.payload.byteLength, 0);
}

function lastPathPart(path: string): string {
  const part = path.split("/").at(-1);
  if (part === undefined || part.length === 0) {
    throw new Error(`segment key has no file name: ${path}`);
  }
  return part;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

interface LiveConnection {
  socket: LiveSocket;
  /** Messages buffered from the moment the socket opens — a listener attached
   * later would lose frames broadcast during awaited fetches (attach-after-fire
   * race: the DO broadcasts DURING the ingest POST). */
  queue: unknown[];
  status: { errored: boolean; closed: boolean };
}

function openLiveSocket(targetSessionId: string): LiveConnection {
  const Socket = readWebSocketConstructor();
  const ticket = signLiveTicket(projectId, targetSessionId, Date.now() + 60_000);
  const socket = new Socket(
    `ws://${worker.address}:${worker.port}/api/v1/projects/${projectId}/sessions/${targetSessionId}/live?ticket=${encodeURIComponent(
      ticket,
    )}`,
  );
  socket.binaryType = "arraybuffer";
  const queue: unknown[] = [];
  const status = { errored: false, closed: false };
  socket.addEventListener("message", (event) => {
    queue.push(event.data);
  });
  socket.addEventListener("error", () => {
    status.errored = true;
  });
  socket.addEventListener("close", () => {
    status.closed = true;
  });
  return { socket, queue, status };
}

function signLiveTicket(
  targetProjectId: string,
  targetSessionId: string,
  expiresAt: number,
): string {
  const signature = createHmac("sha256", apiToken)
    .update(`${targetProjectId}:${targetSessionId}:${expiresAt}`)
    .digest("base64url");
  return Buffer.from(`${expiresAt}.${signature}`).toString("base64url");
}

function readWebSocketConstructor(): LiveSocketConstructor {
  const value = (globalThis as { WebSocket?: LiveSocketConstructor }).WebSocket;
  if (value === undefined) {
    throw new Error("global WebSocket is not available");
  }
  return value;
}

async function waitForSocketMessage(
  conn: LiveConnection,
  label: string,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const next = conn.queue.shift();
    if (next !== undefined) return next;
    if (conn.status.errored) throw new Error(`live socket errored before ${label}`);
    if (conn.status.closed) throw new Error(`live socket closed before ${label}`);
    if (Date.now() >= deadline) {
      throw new Error(`live socket did not receive ${label} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function parseTextMessage<T>(message: unknown): T {
  if (typeof message !== "string") {
    throw new Error("live socket message was not text");
  }
  return JSON.parse(message) as T;
}

async function toBytes(message: unknown): Promise<Uint8Array> {
  if (message instanceof Uint8Array) {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  if (isArrayBufferBody(message)) {
    return new Uint8Array(await message.arrayBuffer());
  }

  throw new Error("live socket message was not binary");
}

function isArrayBufferBody(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
  );
}
