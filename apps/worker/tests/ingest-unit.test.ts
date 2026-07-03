import {
  HDR_FLAGS,
  HDR_KEY,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  MAX_SEQ,
  type BatchIndex,
} from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  mapConfigRowToProjectConfig,
  parseProjectConfig,
  sanitizeBatchIndexEvents,
  validateIngestHeaders,
} from "../src/ingest/helpers.ts";

describe("ingest header validation", () => {
  it("accepts valid headers and defaults flags to zero", () => {
    const headers = new Headers({
      [HDR_KEY]: "raw-key",
      [HDR_SESSION]: "session_12345678",
      [HDR_TAB]: "tab_1",
      [HDR_SEQ]: "12",
    });

    expect(validateIngestHeaders(headers)).toEqual({
      ok: true,
      value: {
        key: "raw-key",
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
          [HDR_KEY]: "raw-key",
          [HDR_SESSION]: "session_12345678",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: String(MAX_SEQ + 1),
        }),
      ),
    ).toEqual({ ok: false, error: `${HDR_SEQ} must be an integer from 0 to ${MAX_SEQ}` });

    expect(
      validateIngestHeaders(
        new Headers({
          [HDR_KEY]: "raw-key",
          [HDR_SESSION]: "session_12345678",
          [HDR_TAB]: "tab_1",
          [HDR_SEQ]: "0",
          [HDR_FLAGS]: "-1",
        }),
      ),
    ).toEqual({ ok: false, error: `${HDR_FLAGS} must be a non-negative integer` });
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

  it("rejects invalid allowed origin JSON", () => {
    expect(
      mapConfigRowToProjectConfig({
        projectId: "project_3",
        active: 1,
        orgId: "org_3",
        retentionDays: 30,
        jurisdiction: null,
        sampleRate: 1,
        allowedOrigins: "not json",
        maskPolicyVersion: 1,
        quotaState: "ok",
        shard: 0,
      }),
    ).toBeNull();
  });
});

describe("ingest sidecar event sanitizing", () => {
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
});
