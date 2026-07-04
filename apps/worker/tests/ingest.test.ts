import { fileURLToPath } from "node:url";
import {
  FLAG_UNCOMPRESSED,
  HDR_FLAGS,
  HDR_KEY,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  MAX_COMPRESSED_BATCH_BYTES,
  MAX_INDEX_JSON_BYTES,
  SDK_FLUSH_DEFAULT_MS,
  encodeIngestBody,
  hashToUnit,
} from "@orange-replay/shared";
import type { BatchIndex, IngestAck, ProjectConfig } from "@orange-replay/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { unstable_dev } from "wrangler";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const payloadBytes = new TextEncoder().encode("payload");

let worker: Awaited<ReturnType<typeof unstable_dev>>;
let workerWithPresenceFailure: Awaited<ReturnType<typeof unstable_dev>>;
let id = 0;

beforeAll(async () => {
  worker = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: { DEV_TEST_ROUTES: "1" },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });

  await seedKey("setup-key", makeConfig(), false);
}, 120_000);

beforeAll(async () => {
  workerWithPresenceFailure = await unstable_dev(`${workerDir}src/index.ts`, {
    config: `${workerDir}wrangler.jsonc`,
    vars: {
      DEV_TEST_ROUTES: "1",
      TEST_TIMINGS: JSON.stringify({ forcePresenceFailure: true }),
    },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });

  await seedKey("presence-failure-key", makeConfig(), true, workerWithPresenceFailure);
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await workerWithPresenceFailure?.stop();
});

describe("ingest route", () => {
  it("answers OPTIONS with ingest CORS headers", async () => {
    const res = await worker.fetch("/v1/ingest", {
      method: "OPTIONS",
      headers: { origin: "https://site.example" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://site.example");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST,OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toContain(HDR_KEY);
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  it("rejects an unknown key", async () => {
    const sessionId = nextSessionId("unknown");
    const res = await postIngest({
      key: "unknown-key",
      sessionId,
      tab: "tab_1",
      seq: 0,
      body: makeBody(sessionId, "tab_1", 0),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("accepts a key seeded through KV", async () => {
    const key = "kv-key";
    await seedKey(key, makeConfig(), true);
    const sessionId = nextSessionId("kv");
    const res = await postIngest({
      key,
      sessionId,
      tab: "tab_kv",
      seq: 0,
      body: makeBody(sessionId, "tab_kv", 0),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as IngestAck).toEqual({
      ok: true,
      live: false,
      flushMs: SDK_FLUSH_DEFAULT_MS,
    });
  });

  it("accepts a key seeded only in D1 by reading through and backfilling", async () => {
    const key = "d1-key";
    await seedKey(key, makeConfig(), false);
    const sessionId = nextSessionId("d1");
    const res = await postIngest({
      key,
      sessionId,
      tab: "tab_d1",
      seq: 0,
      body: makeBody(sessionId, "tab_d1", 0),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as IngestAck).toMatchObject({
      ok: true,
      live: false,
      flushMs: SDK_FLUSH_DEFAULT_MS,
    });
  });

  it("enforces the origin allowlist", async () => {
    const key = "origin-key";
    await seedKey(key, makeConfig({ allowedOrigins: ["https://good.example"] }), true);

    const wrongSessionId = nextSessionId("badorigin");
    const wrongOrigin = await postIngest({
      key,
      sessionId: wrongSessionId,
      tab: "tab_origin",
      seq: 0,
      origin: "https://bad.example",
      body: makeBody(wrongSessionId, "tab_origin", 0),
    });
    expect(wrongOrigin.status).toBe(403);

    const rightSessionId = nextSessionId("okorigin");
    const rightOrigin = await postIngest({
      key,
      sessionId: rightSessionId,
      tab: "tab_origin",
      seq: 0,
      origin: "https://good.example",
      body: makeBody(rightSessionId, "tab_origin", 0),
    });
    expect(rightOrigin.status).toBe(200);
    expect(rightOrigin.headers.get("access-control-allow-origin")).toBe("https://good.example");
    expect(rightOrigin.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("drops quota-exceeded batches without surfacing an SDK error", async () => {
    const key = "quota-key";
    const config = makeConfig({ quotaState: "exceeded" });
    await seedKey(key, config, true);
    const sessionId = nextSessionId("quota");
    const res = await postIngest({
      key,
      sessionId,
      tab: "tab_quota",
      seq: 0,
      body: makeBody(sessionId, "tab_quota", 0),
    });

    expect(res.status).toBe(202);
    expect((await res.json()) as IngestAck).toEqual({
      ok: true,
      live: false,
      flushMs: SDK_FLUSH_DEFAULT_MS,
      drop: true,
    });
    expect(await readDoDebug(config.projectId, sessionId)).toMatchObject({
      hasState: false,
      pendingBatches: 0,
    });
  });

  it("re-checks sampling server-side and drops out-of-sample sessions", async () => {
    const key = "sample-key";
    // Deterministic: pick a rate strictly below/above this session's hash so
    // the same shared FNV-1a decision falls on both sides of the line.
    const sessionId = nextSessionId("sample");
    const unit = hashToUnit(sessionId);
    const config = makeConfig({ sampleRate: Math.max(unit - 0.0001, 0) });
    await seedKey(key, config, true);
    const dropped = await postIngest({
      key,
      sessionId,
      tab: "tab_sample",
      seq: 0,
      body: makeBody(sessionId, "tab_sample", 0),
    });
    expect(dropped.status).toBe(202);
    expect(((await dropped.json()) as IngestAck).drop).toBe(true);
    expect(await readDoDebug(config.projectId, sessionId)).toMatchObject({
      hasState: false,
      pendingBatches: 0,
    });

    const inKey = "sample-key-in";
    await seedKey(
      inKey,
      { ...makeConfig({ sampleRate: Math.min(unit + 0.0001, 1) }), projectId: config.projectId },
      true,
    );
    const accepted = await postIngest({
      key: inKey,
      sessionId,
      tab: "tab_sample",
      seq: 0,
      body: makeBody(sessionId, "tab_sample", 0),
    });
    expect(accepted.status).toBe(200);
  });

  it("rate limits runaway appends for one session", async () => {
    const key = "rate-key";
    await seedKey(key, makeConfig(), true);
    const sessionId = nextSessionId("rate");
    let lastResponse: Response | null = null;

    for (let seq = 0; seq <= 30; seq += 1) {
      lastResponse = await postIngest({
        key,
        sessionId,
        tab: "tab_rate",
        seq,
        body: makeBody(sessionId, "tab_rate", seq),
      });
    }

    if (lastResponse === null) {
      throw new Error("rate test did not send a request");
    }
    expect(lastResponse.status).toBe(429);
    expect(await lastResponse.json()).toEqual({ error: "rate_limited" });
  });

  it("rejects a header and index mismatch", async () => {
    const key = "mismatch-key";
    await seedKey(key, makeConfig(), true);
    const sessionId = nextSessionId("match");
    const indexSessionId = nextSessionId("mismatch");
    const res = await postIngest({
      key,
      sessionId,
      tab: "tab_mismatch",
      seq: 0,
      body: makeBody(indexSessionId, "tab_mismatch", 0),
    });

    expect(res.status).toBe(400);
  });

  it("rejects oversized content by length", async () => {
    const key = "large-key";
    await seedKey(key, makeConfig(), true);
    const sessionId = nextSessionId("large");
    const size = MAX_COMPRESSED_BATCH_BYTES + MAX_INDEX_JSON_BYTES + 1;
    const body = new Uint8Array(size);
    const headers = ingestHeaders(key, sessionId, "tab_large", 0);
    headers["content-length"] = String(size);

    const res = await worker.fetch("/v1/ingest", {
      method: "POST",
      headers,
      body,
    });

    expect(res.status).toBe(413);
  });

  it("rejects an empty payload after the sidecar separator", async () => {
    const key = "empty-payload-key";
    await seedKey(key, makeConfig(), true);
    const sessionId = nextSessionId("empty");
    const res = await postIngest({
      key,
      sessionId,
      tab: "tab_empty",
      seq: 0,
      body: makeBody(sessionId, "tab_empty", 0, new Uint8Array()),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ingest payload is empty" });
  });

  it("rejects payloads over the compressed batch cap even when the sidecar is small", async () => {
    const key = "payload-large-key";
    await seedKey(key, makeConfig(), true);
    const sessionId = nextSessionId("payloadlarge");
    const res = await postIngest({
      key,
      sessionId,
      tab: "tab_payload_large",
      seq: 0,
      body: makeBody(
        sessionId,
        "tab_payload_large",
        0,
        new Uint8Array(MAX_COMPRESSED_BATCH_BYTES + 1),
      ),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "ingest payload is too large" });
  });

  it("rejects a sidecar where t0 is after t1", async () => {
    const key = "bad-time-key";
    await seedKey(key, makeConfig(), true);
    const sessionId = nextSessionId("badtime");
    const index = makeIndex(sessionId, "tab_bad_time", 0);
    index.t0 = 20;
    index.t1 = 10;
    const res = await postIngest({
      key,
      sessionId,
      tab: "tab_bad_time",
      seq: 0,
      body: encodeIngestBody(index, payloadBytes),
    });

    expect(res.status).toBe(400);
  });

  it("gzips uncompressed fallback payloads before appending", async () => {
    const key = "plain-key";
    await seedKey(key, makeConfig(), true);
    const sessionId = nextSessionId("plain");
    const res = await postIngest({
      key,
      sessionId,
      tab: "tab_plain",
      seq: 0,
      flags: FLAG_UNCOMPRESSED,
      body: makeBody(sessionId, "tab_plain", 0, new TextEncoder().encode("plain rrweb bytes")),
    });

    expect(res.status).toBe(200);
  });

  it("keeps ingest successful when the presence registry is unavailable", async () => {
    const sessionId = nextSessionId("presencefail");
    const res = await postIngest(
      {
        key: "presence-failure-key",
        sessionId,
        tab: "tab_presence_fail",
        seq: 0,
        body: makeBody(sessionId, "tab_presence_fail", 0),
      },
      workerWithPresenceFailure,
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as IngestAck).toMatchObject({
      ok: true,
      live: false,
    });
  });
});

async function seedKey(
  key: string,
  config: ProjectConfig,
  kv: boolean,
  targetWorker = worker,
): Promise<{ keyHash: string }> {
  const res = await targetWorker.fetch("/__test/ingest/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, config, kv }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { keyHash: string };
}

async function postIngest(
  input: {
    key: string;
    sessionId: string;
    tab: string;
    seq: number;
    body: Uint8Array;
    flags?: number;
    origin?: string;
  },
  targetWorker = worker,
): Promise<Response> {
  const headers = ingestHeaders(input.key, input.sessionId, input.tab, input.seq, input.flags);
  headers["content-length"] = String(input.body.byteLength);
  if (input.origin !== undefined) {
    headers["origin"] = input.origin;
  }

  return targetWorker.fetch("/v1/ingest", {
    method: "POST",
    headers,
    body: input.body,
  });
}

async function readDoDebug(
  projectId: string,
  sessionId: string,
): Promise<{ hasState: boolean; pendingBatches: number }> {
  const response = await worker.fetch(
    `/__test/do/debug?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(
      sessionId,
    )}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { hasState: boolean; pendingBatches: number };
}

function ingestHeaders(
  key: string,
  sessionId: string,
  tab: string,
  seq: number,
  flags = 0,
): Record<string, string> {
  return {
    [HDR_KEY]: key,
    [HDR_SESSION]: sessionId,
    [HDR_TAB]: tab,
    [HDR_SEQ]: String(seq),
    [HDR_FLAGS]: String(flags),
    "content-type": "application/octet-stream",
  };
}

function makeBody(sessionId: string, tab: string, seq: number, payload = payloadBytes): Uint8Array {
  return encodeIngestBody(makeIndex(sessionId, tab, seq), payload);
}

function makeIndex(sessionId: string, tab: string, seq: number): BatchIndex {
  return {
    v: 1,
    s: sessionId,
    tab,
    seq,
    t0: 1,
    t1: 2,
    e: [],
  };
}

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  const suffix = nextSuffix();
  return {
    projectId: `project_${suffix}`,
    orgId: `org_${suffix}`,
    shard: 0,
    active: true,
    sampleRate: 1,
    allowedOrigins: ["*"],
    maskPolicyVersion: 1,
    quotaState: "ok",
    retentionDays: 30,
    ...overrides,
  };
}

function nextSessionId(label: string): string {
  return `${label}_${nextSuffix()}`.padEnd(16, "0");
}

function nextSuffix(): string {
  id += 1;
  return String(id).padStart(8, "0");
}
