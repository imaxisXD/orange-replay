import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect } from "vite-plus/test";
import { decodeIngestBody, parseSegment, segmentBatch } from "@orange-replay/shared";
import type { BatchIndex, FinalizeMessage, SessionManifest } from "@orange-replay/shared";
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
      ACCEPTED_USAGE_RESERVATIONS: "1",
      TEST_TIMINGS: JSON.stringify(timing),
    },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });

  const schema = await worker.fetch("/__test/consumer/seed-schema", { method: "POST" });
  expect(schema.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await worker?.stop();
});

export interface AppendInput {
  projectId: string;
  orgId?: string;
  sessionId: string;
  tab: string;
  seq: number;
  payload: Uint8Array;
  t0: number;
  t1?: number;
  receivedAt?: number;
  url?: string;
  events?: BatchIndex["e"];
  checkpointTimestamps?: number[];
  attrs?: Record<string, string | number>;
}

export interface DebugBody {
  hasState: boolean;
  schemaReady: boolean;
  finalized: boolean;
  bufferedBytes: number;
  pendingBatches: number;
  segmentCount: number;
  stateBytes: number;
  tombstonePurgeAt?: number;
}

export interface AppendResultBody {
  live: boolean;
  closed: boolean;
  flushMs: number;
  checkpoint?: boolean;
  rateLimited?: boolean;
}

interface LiveSocket {
  binaryType: string;
  close(): void;
  send(data: string | ArrayBuffer): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
}

interface LiveSocketConstructor {
  new (url: string): LiveSocket;
}

export interface LiveConnection {
  socket: LiveSocket;
  queue: unknown[];
  status: { errored: boolean; closed: boolean; closeCode?: number; closeReason?: string };
}

export async function append(input: AppendInput): Promise<AppendResultBody> {
  const response = await sendAppend(input);
  expect(response.status).toBe(200);
  return (await response.json()) as AppendResultBody;
}

export async function appendStatus(input: AppendInput): Promise<number> {
  return (await sendAppend(input)).status;
}

async function sendAppend(input: AppendInput): Promise<Response> {
  const index: BatchIndex = {
    v: 1,
    s: input.sessionId,
    tab: input.tab,
    seq: input.seq,
    t0: input.t0,
    t1: input.t1 ?? input.t0 + 50,
    u: input.url ?? `/page-${input.seq}`,
    e: input.events ?? [{ t: input.t0 + 1, k: "custom", d: `batch-${input.seq}` }],
    ...(input.checkpointTimestamps === undefined
      ? {}
      : { checkpointTimestamps: input.checkpointTimestamps }),
  };
  const response = await worker.fetch("/__test/do/append", {
    method: "POST",
    body: JSON.stringify({
      projectId: input.projectId,
      orgId: input.orgId ?? "org",
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
  return response;
}

export async function readUsage(orgId: string): Promise<Record<string, unknown>[]> {
  const response = await worker.fetch(`/__test/consumer/usage?org=${encodeURIComponent(orgId)}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { usage: Record<string, unknown>[] };
  return body.usage;
}

export async function readUsageLedger(
  projectId: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const response = await worker.fetch(
    `/__test/consumer/usage-ledger?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(sessionId)}`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ledger: Record<string, unknown> | null };
  return body.ledger;
}

export async function configureUsageReservationFailure(input: {
  projectId: string;
  sessionId: string;
  enabled: boolean;
}): Promise<void> {
  const response = await worker.fetch("/__test/consumer/fail-usage-reservation", {
    method: "POST",
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
}

export async function seedDeletionMarker(projectId: string, sessionId: string): Promise<void> {
  const response = await worker.fetch("/__test/consumer/seed-deletion", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId }),
  });

  expect(response.status).toBe(200);
}

export async function seedBatches(input: {
  projectId: string;
  sessionId: string;
  tab: string;
  startSeq: number;
  count: number;
  payloadBytes: number;
  t0: number;
  analyticsVersion?: number;
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
      analyticsVersion: input.analyticsVersion,
    }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as DebugBody;
}

export async function flush(
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

export async function forceFinalize(projectId: string, sessionId: string): Promise<void> {
  const response = await worker.fetch("/__test/do/finalize", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId }),
  });

  expect(response.status).toBe(200);
}

export async function markFinalizingForTest(projectId: string, sessionId: string): Promise<void> {
  const response = await worker.fetch("/__test/do/mark-finalizing", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId }),
  });

  expect(response.status).toBe(200);
}

export async function runAlarmForTest(projectId: string, sessionId: string): Promise<void> {
  const response = await worker.fetch("/__test/do/alarm", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId }),
  });

  expect(response.status).toBe(200);
}

export async function indexSessionNowForTest(message: FinalizeMessage): Promise<void> {
  const response = await worker.fetch("/__test/consumer/index-now", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });

  expect(response.status).toBe(200);
}

export async function readDebug(projectId: string, sessionId: string): Promise<DebugBody> {
  const response = await worker.fetch(
    `/__test/do/debug?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
  );

  expect(response.status).toBe(200);
  return (await response.json()) as DebugBody;
}

export async function readR2Bytes(key: string): Promise<Uint8Array> {
  const response = await worker.fetch(`/__test/do/r2?key=${encodeURIComponent(key)}`);

  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

export async function waitForR2Bytes(key: string): Promise<Uint8Array> {
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

export async function readManifestPayloads(manifest: SessionManifest): Promise<string[]> {
  const payloads: string[] = [];
  for (const segment of manifest.segments) {
    const parsed = parseSegment(await readR2Bytes(segment.key));
    for (let index = 0; index < parsed.count; index += 1) {
      payloads.push(
        Buffer.from(decodeIngestBody(segmentBatch(parsed, index)).payload).toString("hex"),
      );
    }
  }
  return payloads;
}

export function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function openDoLiveSocket(projectId: string, sessionId: string): LiveConnection {
  const Socket = readWebSocketConstructor();
  const socket = new Socket(
    `ws://${worker.address}:${worker.port}/__test/do/live?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
  );
  socket.binaryType = "arraybuffer";
  const queue: unknown[] = [];
  const status: LiveConnection["status"] = { errored: false, closed: false };
  socket.addEventListener("message", (event) => {
    queue.push(event.data);
  });
  socket.addEventListener("error", () => {
    status.errored = true;
  });
  socket.addEventListener("close", (event) => {
    status.closed = true;
    status.closeCode = event.code;
    status.closeReason = event.reason;
  });
  return { socket, queue, status };
}

function readWebSocketConstructor(): LiveSocketConstructor {
  const value = (globalThis as { WebSocket?: LiveSocketConstructor }).WebSocket;
  if (value === undefined) {
    throw new Error("global WebSocket is not available");
  }
  return value;
}

export async function waitForSocketMessage(
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
    await sleep(25);
  }
}

export async function waitForSocketClose(conn: LiveConnection, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!conn.status.closed) {
    if (conn.status.errored) throw new Error("live socket errored before closing");
    if (Date.now() >= deadline) throw new Error(`live socket did not close within ${timeoutMs}ms`);
    await sleep(25);
  }
}

export function parseTextMessage<T>(message: unknown): T {
  if (typeof message !== "string") {
    throw new Error("live socket message was not text");
  }
  return JSON.parse(message) as T;
}

export interface PresenceListBody {
  truncated: boolean;
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

export interface PresenceHeadsBody {
  sessions: Array<
    PresenceListBody["sessions"][number] & {
      org_id?: string | null;
      finalizing_at?: number | null;
      region?: string | null;
      flags?: number;
      activity: "live" | "idle" | "finalizing";
    }
  >;
}

export async function presencePing(input: {
  projectId: string;
  sessionId: string;
  startedAt: number;
  lastSeen: number;
  entryUrl: string;
  browser?: string;
  expiresAt?: number;
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
      browser: input.browser ?? "Chrome",
      os: "macOS",
      device: "desktop",
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    }),
  });

  expect(response.status).toBe(200);
}

export async function presenceRemove(projectId: string, sessionId: string): Promise<void> {
  const response = await worker.fetch("/__test/do/presence/remove", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId }),
  });

  expect(response.status).toBe(200);
}

export async function presenceMarkFinalizing(
  projectId: string,
  sessionId: string,
  finalizingAt = Date.now(),
): Promise<void> {
  const response = await worker.fetch("/__test/do/presence/mark-finalizing", {
    method: "POST",
    body: JSON.stringify({ projectId, sessionId, finalizingAt }),
  });

  expect(response.status).toBe(200);
}

export async function readPresenceList(
  projectId: string,
  now = Date.now(),
): Promise<PresenceListBody> {
  const response = await worker.fetch("/__test/do/presence/list", {
    method: "POST",
    body: JSON.stringify({ projectId, now }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as PresenceListBody;
}

export async function readPresenceHeads(
  projectId: string,
  now = Date.now(),
  query: Record<string, unknown> = {},
): Promise<PresenceHeadsBody> {
  const response = await worker.fetch("/__test/do/presence/heads", {
    method: "POST",
    body: JSON.stringify({ projectId, now, ...query }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as PresenceHeadsBody;
}

export async function readPresenceDebug(
  projectId: string,
): Promise<{ rows: number; firstEventAt: number | null }> {
  const response = await worker.fetch("/__test/do/presence/debug", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as { rows: number; firstEventAt: number | null };
}

export async function readPresenceInstallStatus(
  projectId: string,
): Promise<{ firstEventAt: number | null }> {
  const response = await worker.fetch("/__test/do/presence/install-status", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });

  expect(response.status).toBe(200);
  return (await response.json()) as { firstEventAt: number | null };
}

export async function pollPresenceList(
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
