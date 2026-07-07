import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MAX_INDEX_JSON_BYTES,
  batchIndexSchema,
  buildSegment,
  configKvKey,
  decodeIngestBody,
  encodeIngestBody,
  manifestKey,
  ingestAckSchema,
  parseSegment,
  segmentBatch,
  segmentKey,
  sessionPrefix,
  uuidv7,
  finalizeMessageSchema,
  sessionManifestSchema,
  setWideEventVersion,
  startWideEvent,
} from "../src/index.ts";
import type { BatchIndex, FinalizeMessage, SessionManifest } from "../src/index.ts";

const encoder = new TextEncoder();

afterEach(() => {
  vi.restoreAllMocks();
  setWideEventVersion(undefined);
});

describe("ingest body wire format", () => {
  it("round-trips unicode, escaped nul strings, and binary payloads", () => {
    const index: BatchIndex = {
      v: 1,
      s: "018f6f7a-7f83-7000-9000-111111111111",
      tab: "tab-a",
      seq: 0,
      t0: 1_000,
      t1: 2_000,
      u: "https://example.com/path",
      e: [
        {
          t: 1_100,
          k: "custom",
          d: "unicode \u2603 and nul \0 stays escaped",
          m: { count: 2, label: "ok" },
        },
      ],
    };
    const payload = new Uint8Array([0, 255, 1, 2, 0, 127]);

    const encoded = encodeIngestBody(index, payload);
    const decoded = decodeIngestBody(encoded);

    expect(decoded.index).toEqual(index);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it("keeps escaped nul characters out of the JSON bytes", () => {
    const index: BatchIndex = {
      v: 1,
      s: "session",
      tab: "tab",
      seq: 1,
      t0: 1,
      t1: 1,
      e: [{ t: 1, k: "error", d: "contains \0 inside string" }],
    };
    const encoded = encodeIngestBody(index, new Uint8Array([1, 2, 3]));
    const nulCount = Array.from(encoded).filter((byte) => byte === 0).length;

    expect(nulCount).toBe(1);
    expect(decodeIngestBody(encoded).index.e[0]?.d).toBe("contains \0 inside string");
  });

  it("rejects bodies without a separator", () => {
    expect(() => decodeIngestBody(encoder.encode("{}"))).toThrow(
      "ingest body separator is missing",
    );
  });

  it("rejects oversized index JSON", () => {
    const oversized = new Uint8Array(MAX_INDEX_JSON_BYTES + 1);
    oversized.fill(0x7b);

    expect(() => decodeIngestBody(oversized)).toThrow(
      `ingest index JSON exceeds ${MAX_INDEX_JSON_BYTES} bytes`,
    );
  });
});

describe("ORS1 segment wire format", () => {
  it("round-trips batches with exact byte slices", () => {
    const allBatches = [
      new Uint8Array([1]),
      new Uint8Array([2, 3, 4]),
      new Uint8Array([0, 255, 127, 64]),
      encoder.encode("batch-four"),
      new Uint8Array([9, 8, 7, 6, 5]),
      encoder.encode("batch-six"),
    ];

    for (let count = 1; count <= allBatches.length; count += 1) {
      const batches = allBatches.slice(0, count);
      const segment = buildSegment(batches);
      const parsed = parseSegment(segment);

      expect(parsed.count).toBe(batches.length);
      for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        expect(batch).toBeDefined();
        expect(Array.from(segmentBatch(parsed, i))).toEqual(Array.from(batch ?? []));
      }
    }
  });

  it("rejects corrupt magic", () => {
    const segment = buildSegment([new Uint8Array([1, 2, 3])]);
    const corrupt = segment.slice();
    corrupt[0] = 0x58;

    expect(() => parseSegment(corrupt)).toThrow("segment magic must be ORS1");
  });

  it("rejects non-monotonic offsets", () => {
    const segment = buildSegment([new Uint8Array([1]), new Uint8Array([2])]);
    const corrupt = segment.slice();
    const view = new DataView(corrupt.buffer, corrupt.byteOffset, corrupt.byteLength);
    view.setUint32(12, 0, true);

    expect(() => parseSegment(corrupt)).toThrow("segment offsets must be strictly increasing");
  });

  it("rejects offsets outside data bounds", () => {
    const segment = buildSegment([new Uint8Array([1]), new Uint8Array([2])]);
    const corrupt = segment.slice();
    const view = new DataView(corrupt.buffer, corrupt.byteOffset, corrupt.byteLength);
    const dataBytes = corrupt.byteLength - 16;
    view.setUint32(12, dataBytes + 1, true);

    expect(() => parseSegment(corrupt)).toThrow("segment offset is outside data bounds");
  });
});

describe("constants", () => {
  it("builds storage keys", () => {
    expect(sessionPrefix("project", "session")).toBe("p/project/session");
    expect(segmentKey("project", "session", 7)).toBe("p/project/session/seg-000007.ors");
    expect(manifestKey("project", "session")).toBe("p/project/session/manifest.json");
    expect(configKvKey("hash")).toBe("k:hash");
  });
});

describe("uuidv7", () => {
  it("sets the RFC 9562 version and variant bits", () => {
    const id = uuidv7();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps the millisecond timestamp in sortable prefix order", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_002);

    const first = uuidv7();
    const second = uuidv7();

    expect(first.slice(0, 13) < second.slice(0, 13)).toBe(true);
  });
});

describe("schemas", () => {
  it("validates batch indexes and manifests", () => {
    const batch: BatchIndex = {
      v: 1,
      s: "session",
      tab: "tab",
      seq: 0,
      t0: 1,
      t1: 2,
      u: "/home?view=checkout#step",
      e: [{ t: 1, k: "click" }],
    };
    const manifest: SessionManifest = {
      v: 1,
      sessionId: "session",
      projectId: "project",
      orgId: "org",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      segments: [{ key: "p/project/session/seg-000001.ors", bytes: 1, t0: 1, t1: 2, batches: 1 }],
      timeline: batch.e,
      counts: { batches: 1, events: 1, clicks: 1, errors: 0, rages: 0, navs: 0 },
      bytes: 1,
      flags: 0,
      attrs: { country: "US", entryUrl: "/home", urlCount: 1 },
    };

    expect(batchIndexSchema.parse(batch)).toEqual(batch);
    expect(sessionManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      ingestAckSchema.parse({ ok: true, live: true, flushMs: 4_000, checkpoint: true }),
    ).toEqual({ ok: true, live: true, flushMs: 4_000, checkpoint: true });
    expect(batchIndexSchema.safeParse({ ...batch, u: "javascript:alert(1)" }).success).toBe(false);
  });

  it("validates finalize messages with session flags", () => {
    const message: FinalizeMessage = {
      type: "session.finalized",
      sessionId: "session",
      projectId: "project",
      orgId: "org",
      shard: 0,
      requestId: "request",
      manifestKey: "p/project/session/manifest.json",
      startedAt: 1,
      endedAt: 2,
      bytes: 3,
      segments: 1,
      flags: 5,
      counts: { batches: 1, events: 1, clicks: 0, errors: 1, rages: 0, navs: 0 },
      attrs: {},
      retentionDays: 30,
      events: [{ t: 1, k: "error", d: "failed" }],
    };

    expect(finalizeMessageSchema.parse(message)).toEqual(message);
  });
});

describe("wide-event logger", () => {
  it("emits one console line with required base fields", () => {
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const event = startWideEvent("shared", "unit.test", "req-1");

    event.set({ project_id: "project" });
    event.emit();
    event.emit();

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed["ts"]).toEqual(expect.any(String));
    expect(parsed["service"]).toBe("shared");
    expect(parsed["event"]).toBe("unit.test");
    expect(parsed["request_id"]).toBe("req-1");
    expect(parsed["outcome"]).toBe("success");
    expect(parsed["version"]).toBe("dev");
    expect(parsed["project_id"]).toBe("project");
    expect(typeof parsed["duration_ms"]).toBe("number");
    expect(Number(parsed["duration_ms"])).toBeGreaterThanOrEqual(0);
  });

  it("emits failed events as server errors", () => {
    const log = vi.spyOn(globalThis["console"], "log").mockImplementation(() => undefined);
    const error = vi.spyOn(globalThis["console"], "error").mockImplementation(() => undefined);
    const event = startWideEvent("shared", "unit.fail", "req-2");

    event.fail(new Error("write failed"));
    event.emit();

    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed["outcome"]).toBe("server_error");
    expect(parsed["error_message"]).toBe("write failed");
  });

  it("uses the configured app version and truncates error messages", () => {
    const error = vi.spyOn(globalThis["console"], "error").mockImplementation(() => undefined);
    const event = startWideEvent("shared", "unit.version", "req-3");

    setWideEventVersion("2026.7.4");
    event.fail(new Error("x".repeat(600)));
    event.emit();

    const line = String(error.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["version"]).toBe("2026.7.4");
    expect(String(parsed["error_message"])).toHaveLength(500);
  });
});
