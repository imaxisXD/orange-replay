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
} from "@orange-replay/shared";
import type { BatchIndex, IngestAck, ProjectConfig } from "@orange-replay/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { unstable_dev } from "wrangler";

const workerDir = fileURLToPath(new URL("..", import.meta.url));
const payloadBytes = new TextEncoder().encode("payload");

let worker: Awaited<ReturnType<typeof unstable_dev>>;
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

afterAll(async () => {
  await worker?.stop();
});

describe("ingest route", () => {
  it("answers OPTIONS with ingest CORS headers", async () => {
    const res = await worker.fetch("/v1/ingest", { method: "OPTIONS" });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
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
  });

  it("drops quota-exceeded batches without surfacing an SDK error", async () => {
    const key = "quota-key";
    await seedKey(key, makeConfig({ quotaState: "exceeded" }), true);
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
});

async function seedKey(
  key: string,
  config: ProjectConfig,
  kv: boolean,
): Promise<{ keyHash: string }> {
  const res = await worker.fetch("/__test/ingest/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, config, kv }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { keyHash: string };
}

async function postIngest(input: {
  key: string;
  sessionId: string;
  tab: string;
  seq: number;
  body: Uint8Array;
  flags?: number;
  origin?: string;
}): Promise<Response> {
  const headers = ingestHeaders(input.key, input.sessionId, input.tab, input.seq, input.flags);
  if (input.origin !== undefined) {
    headers["origin"] = input.origin;
  }

  return worker.fetch("/v1/ingest", {
    method: "POST",
    headers,
    body: input.body,
  });
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
