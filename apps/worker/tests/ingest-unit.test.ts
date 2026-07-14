import {
  HDR_FLAGS,
  HDR_KEY,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  MAX_SEQ,
  type BatchIndex,
} from "@orange-replay/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  mapConfigRowToProjectConfig,
  ingestPostHeaders,
  parseProjectConfig,
  readContentLength,
  sanitizeBatchIndexEvents,
  validateIngestHeaders,
} from "../src/ingest/helpers.ts";
import { handleIngest } from "../src/ingest/handler.ts";
import { ingestAckForAppendResult } from "../src/ingest/response.ts";
import { analyticsSidecarLines } from "../src/do/session-analytics-sidecar.ts";
import type { Env } from "../src/env.ts";

const validWriteKey = testWriteKey("unit");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingest header validation", () => {
  it("accepts valid headers and defaults flags to zero", () => {
    const headers = new Headers({
      [HDR_KEY]: validWriteKey,
      [HDR_SESSION]: "session_12345678",
      [HDR_TAB]: "tab_1",
      [HDR_SEQ]: "12",
    });

    expect(validateIngestHeaders(headers)).toEqual({
      ok: true,
      value: {
        key: validWriteKey,
        sessionId: "session_12345678",
        tab: "tab_1",
        seq: 12,
        flags: 0,
      },
    });
  });

  it("rejects missing keys and bad ids", () => {
    expect(
      validateIngestHeaders(
        new Headers({
          [HDR_SESSION]: "session_12345678",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: "0",
        }),
      ),
    ).toEqual({ ok: false, error: `${HDR_KEY} is required` });

    expect(
      validateIngestHeaders(
        new Headers({
          [HDR_KEY]: "raw-key",
          [HDR_SESSION]: "session_12345678",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: "0",
        }),
      ),
    ).toEqual({
      ok: false,
      error: `${HDR_KEY} must be a generated key like or_live_ plus 32 base64url characters`,
    });

    expect(
      validateIngestHeaders(
        new Headers({
          [HDR_KEY]: validWriteKey,
          [HDR_SESSION]: "short",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: "0",
        }),
      ),
    ).toEqual({
      ok: false,
      error: `${HDR_SESSION} must be 16 to 64 letters, numbers, underscores, or dashes`,
    });
  });

  it("rejects seq and flags outside the allowed shape", () => {
    expect(
      validateIngestHeaders(
        new Headers({
          [HDR_KEY]: validWriteKey,
          [HDR_SESSION]: "session_12345678",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: String(MAX_SEQ + 1),
        }),
      ),
    ).toEqual({ ok: false, error: `${HDR_SEQ} must be an integer from 0 to ${MAX_SEQ}` });

    expect(
      validateIngestHeaders(
        new Headers({
          [HDR_KEY]: validWriteKey,
          [HDR_SESSION]: "session_12345678",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: "0",
          [HDR_FLAGS]: "-1",
        }),
      ),
    ).toEqual({ ok: false, error: `${HDR_FLAGS} can only include supported ingest flags` });

    expect(
      validateIngestHeaders(
        new Headers({
          [HDR_KEY]: validWriteKey,
          [HDR_SESSION]: "session_12345678",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: "0",
          [HDR_FLAGS]: "2147483648",
        }),
      ),
    ).toEqual({ ok: false, error: `${HDR_FLAGS} can only include supported ingest flags` });
  });

  it("rejects missing or invalid content lengths", async () => {
    // Missing content-length is tolerated (proxies re-chunk; the capped body
    // read enforces the size limit instead) — only malformed values reject.
    expect(readContentLength(new Headers())).toEqual({
      ok: false,
      malformed: false,
      error: "content-length is absent",
    });
    expect(readContentLength(new Headers({ "content-length": "chunked" }))).toEqual({
      ok: false,
      malformed: true,
      error: "content-length must be a valid integer",
    });
    expect(readContentLength(new Headers({ "content-length": "10" }))).toEqual({
      ok: true,
      value: 10,
    });

    vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const response = await handleIngest(
      new Request("https://replay.test/v1/ingest", {
        method: "POST",
        headers: {
          [HDR_KEY]: validWriteKey,
          [HDR_SESSION]: "session_12345678",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: "0",
          "content-length": "not-a-number",
        },
      }),
      {} as Env,
      {} as Parameters<typeof handleIngest>[2],
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "content-length must be a valid integer",
    });
  });

  it("fails closed when production rate limiting is not configured", async () => {
    vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const response = await handleIngest(
      new Request("https://replay.test/v1/ingest", {
        method: "POST",
        headers: {
          [HDR_KEY]: validWriteKey,
          [HDR_SESSION]: "session_12345678",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: "0",
          "content-length": "0",
        },
      }),
      {} as Env,
      {} as Parameters<typeof handleIngest>[2],
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });
});

describe("ingest config row mapping", () => {
  it("treats invalid cached config as a miss", () => {
    expect(parseProjectConfig({ projectId: "missing fields" })).toBeNull();
  });

  it("maps a valid D1 row into project config", () => {
    expect(
      mapConfigRowToProjectConfig({
        projectId: "project_1",
        active: 1,
        orgId: "org_1",
        retentionDays: 30,
        jurisdiction: null,
        sampleRate: 1,
        allowedOrigins: JSON.stringify(["https://app.example"]),
        maskPolicyVersion: 2,
        quotaState: "ok",
        shard: 0,
      }),
    ).toEqual({
      projectId: "project_1",
      orgId: "org_1",
      shard: 0,
      active: true,
      sampleRate: 1,
      allowedOrigins: ["https://app.example"],
      maskPolicyVersion: 2,
      quotaState: "ok",
      retentionDays: 30,
    });
  });

  it("keeps inactive rows valid so the handler can reject them as inactive", () => {
    expect(
      mapConfigRowToProjectConfig({
        projectId: "project_2",
        active: 0,
        orgId: "org_2",
        retentionDays: 7,
        jurisdiction: "eu",
        sampleRate: 0.5,
        allowedOrigins: JSON.stringify(["*"]),
        maskPolicyVersion: 1,
        quotaState: "soft",
        shard: 1,
      }),
    ).toEqual({
      projectId: "project_2",
      orgId: "org_2",
      shard: 1,
      active: false,
      sampleRate: 0.5,
      allowedOrigins: ["*"],
      maskPolicyVersion: 1,
      quotaState: "soft",
      retentionDays: 7,
      jurisdiction: "eu",
    });
  });

  it("rejects invalid allowed origins from stored config rows", () => {
    const invalidAllowedOrigins: unknown[] = [
      "not json",
      JSON.stringify(["https://app.example", 1]),
      ["https://app.example"],
    ];

    for (const allowedOrigins of invalidAllowedOrigins) {
      expect(
        mapConfigRowToProjectConfig({
          projectId: "project_invalid",
          active: 1,
          orgId: "org_invalid",
          retentionDays: 30,
          jurisdiction: null,
          sampleRate: 1,
          allowedOrigins,
          maskPolicyVersion: 1,
          quotaState: "ok",
          shard: 0,
        }),
      ).toBeNull();
    }
  });

  it("keeps a new project's empty origin list as deny-all", () => {
    expect(
      mapConfigRowToProjectConfig({
        projectId: "project_new",
        active: 1,
        orgId: "org_new",
        retentionDays: 30,
        jurisdiction: null,
        sampleRate: 1,
        allowedOrigins: "[]",
        maskPolicyVersion: 1,
        quotaState: "ok",
        shard: 0,
      })?.allowedOrigins,
    ).toEqual([]);
  });

  it("does not turn empty allowed origins into wildcard CORS", () => {
    const headers = ingestPostHeaders(
      new Request("https://worker.test/v1/ingest", {
        headers: { origin: "https://site.example" },
      }),
      [],
    );

    expect(headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("ingest sidecar event sanitizing", () => {
  it("keeps valid replay checkpoints through production ingest sanitizing", () => {
    const index = {
      v: 1,
      s: "session_12345678",
      tab: "tab_1",
      seq: 0,
      t0: 100,
      t1: 200,
      e: [],
      checkpointTimestamps: [120, 180],
    } satisfies BatchIndex;

    expect(sanitizeBatchIndexEvents(index).index.checkpointTimestamps).toEqual([120, 180]);
  });

  it("removes replay checkpoints outside the batch time range", () => {
    const index = {
      v: 1,
      s: "session_12345678",
      tab: "tab_1",
      seq: 0,
      t0: 100,
      t1: 200,
      e: [],
      checkpointTimestamps: [250],
    } as BatchIndex;

    expect(sanitizeBatchIndexEvents(index).index.checkpointTimestamps).toBeUndefined();
  });

  it("keeps only sane events and counts dropped entries", () => {
    const hostileIndex = {
      v: 1,
      s: "session_12345678",
      tab: "tab_1",
      seq: 0,
      t0: 1,
      t1: 2,
      e: [
        { t: 1, k: "click", d: "x".repeat(250), m: { a: "ok", b: 2 } },
        { t: Number.NaN, k: "error" },
        { t: 2, k: "bad-kind" },
        { t: 3, k: "custom", m: { nested: { nope: true } } },
        {
          t: 4,
          k: "custom",
          m: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, "x"])),
        },
        ...Array.from({ length: 205 }, (_, index) => ({
          t: 10 + index,
          k: "nav",
          d: `nav-${index}`,
        })),
      ],
    };

    const sanitized = sanitizeBatchIndexEvents(hostileIndex as BatchIndex);

    expect(sanitized.eventsDropped).toBe(10);
    expect(sanitized.index.e).toHaveLength(200);
    expect(sanitized.index.e[0]).toEqual({
      t: 1,
      k: "click",
      d: "x".repeat(200),
      m: { a: "ok", b: 2 },
    });
    expect(sanitized.index.e[1]).toEqual({ t: 3, k: "custom" });
    expect(sanitized.index.e[2]).toEqual({ t: 4, k: "custom" });
    expect(sanitized.index.e.every((event) => Number.isFinite(event.t))).toBe(true);
  });

  it("truncates large metadata before the batch can inflate storage", () => {
    const index = {
      v: 1,
      s: "session_12345678",
      tab: "tab_1",
      seq: 0,
      t0: 1,
      t1: 2,
      e: Array.from({ length: 80 }, (_, eventIndex) => ({
        t: eventIndex,
        k: "custom",
        m: {
          [`long_key_${eventIndex}_${"k".repeat(300)}`]: "v".repeat(800),
        },
      })),
    } satisfies BatchIndex;

    const sanitized = sanitizeBatchIndexEvents(index);
    const metaBytes = sanitized.index.e.reduce((total, event) => {
      return total + new TextEncoder().encode(JSON.stringify(event.m ?? {})).byteLength;
    }, 0);

    expect(metaBytes).toBeLessThanOrEqual(16 * 1024);
    const firstMeta = sanitized.index.e[0]?.m;
    expect(firstMeta).toBeDefined();
    const [firstKey, firstValue] = Object.entries(firstMeta ?? {})[0] ?? ["", ""];
    expect(firstKey.length).toBeLessThanOrEqual(200);
    expect(String(firstValue).length).toBeLessThanOrEqual(200);
  });

  it("strips URL queries and fragments before D1 or R2 sidecars can store them", () => {
    const secret = "secret-token-123";
    const index = {
      v: 1,
      s: "session_12345678",
      tab: "tab_1",
      seq: 0,
      t0: 1,
      t1: 4,
      u: `https://shop.example/checkout?token=${secret}#payment`,
      e: [
        {
          t: 2,
          k: "nav",
          d: `/account?access_token=${secret}#security`,
        },
        {
          t: 3,
          k: "vital",
          d: "navigation",
          m: {
            url: `https://shop.example/orders?session=${secret}#latest`,
            href: `/orders/1?key=${secret}#receipt`,
            referrer: `https://search.example/results?q=shoes&token=${secret}#result`,
            page_url: `/checkout?token=${secret}#payment`,
            redirect_uri: `https://shop.example/complete?code=${secret}`,
            URL: `https://shop.example/account?session=${secret}`,
            Href: `/account/1?key=${secret}#private`,
            destination: `https://shop.example/profile?access_token=${secret}`,
          },
        },
      ],
    } satisfies BatchIndex;

    const sanitized = sanitizeBatchIndexEvents(index).index;
    expect(sanitized.u).toBe("/checkout");
    expect(sanitized.e).toEqual([
      { t: 2, k: "nav", d: "/account" },
      {
        t: 3,
        k: "vital",
        d: "navigation",
        m: {
          url: "/orders",
          href: "/orders/1",
          referrer: "/results",
          page_url: "/checkout",
          redirect_uri: "/complete",
          URL: "/account",
          Href: "/account/1",
          destination: "/profile",
        },
      },
    ]);

    const storedEvents = JSON.stringify(sanitized.e);
    const sidecar = [...analyticsSidecarLines([{ events: storedEvents }])].join("");
    expect(storedEvents).not.toContain(secret);
    expect(sidecar).not.toContain(secret);
    expect(sidecar).not.toContain("access_token");
  });
});

describe("ingest append acknowledgments", () => {
  it("relays a permanent session-cap drop to the SDK", () => {
    expect(
      ingestAckForAppendResult({
        live: false,
        closed: false,
        flushMs: 15_000,
        drop: true,
      }),
    ).toEqual({
      ok: true,
      live: false,
      closed: undefined,
      flushMs: 15_000,
      checkpoint: undefined,
      drop: true,
    });
  });
});

function testWriteKey(label: string): string {
  return `or_live_${label
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .padEnd(32, "0")
    .slice(0, 32)}`;
}
