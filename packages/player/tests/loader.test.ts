// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BatchIndex, SessionManifest } from "@orange-replay/shared/types";
import { buildSegment, encodeIngestBody } from "@orange-replay/shared/wire";
import { fetchSegmentBytes, liveSocketUrl, loadSession, mintLiveTicket } from "../src/api.ts";
import { OrangePlayer } from "../src/player.ts";
import {
  decodeSegmentBatches,
  decodeSegmentEvents,
  MAX_DECODED_SEGMENT_EVENTS,
  MAX_DECODED_SEGMENT_EVENT_BYTES,
} from "../src/segments.ts";
import type { ReplayEvent } from "../src/types.ts";
import { DecodeWorkerHost } from "../src/worker-host.ts";

const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("manifest and segment loading", () => {
  it("loads a manifest and decodes an ORS1 segment built by shared helpers", async () => {
    const events = [makeEvent(1_100, "full"), makeEvent(1_200, "click")];
    const segment = buildSegment([await gzipJson(events)]);
    const manifest = makeManifest(segment.byteLength);
    const fetchCalls: string[] = [];
    const api = {
      baseUrl: "https://api.example.test",
      fetch: async (url: string | URL | Request) => {
        const requestUrl = requestUrlString(url);
        fetchCalls.push(requestUrl);

        if (requestUrl.endsWith("/manifest")) {
          return Response.json(manifest);
        }

        return new Response(segment as unknown as BodyInit, {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    };

    const loadedManifest = await loadSession(api, {
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
    });
    const segmentBytes = await fetchSegmentBytes(api, {
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
      segment: manifest.segments[0]!,
    });
    const worker = new DecodeWorkerHost({ allowSynchronousFallback: true });

    expect(loadedManifest).toEqual(manifest);
    expect(await decodeSegmentEvents(segmentBytes, worker)).toEqual(events);
    expect(fetchCalls).toEqual([
      "https://api.example.test/api/v1/projects/project/sessions/session/manifest",
      "https://api.example.test/api/v1/projects/project/sessions/session/segments/seg-000001.ors",
    ]);
  });

  it("preserves tab indexes when decoding encoded segment batches", async () => {
    const tabAEvents = [makeEvent(1_100, "tab-a-full")];
    const tabBEvents = [makeEvent(1_200, "tab-b-click")];
    const segment = buildSegment([
      encodeIngestBody(makeIndex("tab-b", 0, 1_200), await gzipJson(tabBEvents)),
      encodeIngestBody(makeIndex("tab-a", 0, 1_100), await gzipJson(tabAEvents)),
    ]);
    const worker = new DecodeWorkerHost({ allowSynchronousFallback: true });

    const batches = await decodeSegmentBatches(segment, worker);

    expect(batches.map((batch) => batch.index.tab)).toEqual(["tab-a", "tab-b"]);
    expect(batches.map((batch) => batch.events)).toEqual([tabAEvents, tabBEvents]);
  });

  it("decodes segment batches one at a time", async () => {
    const segment = buildSegment([
      encodeIngestBody(makeIndex("tab-a", 0, 1_100), encoder.encode("batch-a")),
      encodeIngestBody(makeIndex("tab-b", 0, 1_200), encoder.encode("batch-b")),
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = {
      decodeBatchWithStats: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return { decodedBytes: 64, events: [makeEvent(1_100, "decoded")] };
      },
    } as unknown as DecodeWorkerHost;

    await decodeSegmentBatches(segment, worker);

    expect(maxInFlight).toBe(1);
  });

  it("rejects segments with too many decoded events", async () => {
    const segment = buildSegment([
      encodeIngestBody(makeIndex("tab-a", 0, 1_100), encoder.encode("batch-a")),
    ]);
    const worker = {
      decodeBatchWithStats: async () => ({
        decodedBytes: 64,
        events: Array.from({ length: MAX_DECODED_SEGMENT_EVENTS + 1 }, (_, index) =>
          makeEvent(index, "event"),
        ),
      }),
    } as unknown as DecodeWorkerHost;

    await expect(decodeSegmentBatches(segment, worker)).rejects.toThrow(
      "Replay segment has too many events.",
    );
  });

  it("rejects segments when aggregate decoded bytes exceed the limit", async () => {
    const segment = buildSegment([
      encodeIngestBody(makeIndex("tab-a", 0, 1_100), encoder.encode("batch-a")),
    ]);
    const worker = {
      decodeBatchWithStats: async () => ({
        decodedBytes: MAX_DECODED_SEGMENT_EVENT_BYTES + 1,
        events: [makeEvent(1_100, "decoded")],
      }),
    } as unknown as DecodeWorkerHost;

    await expect(decodeSegmentBatches(segment, worker)).rejects.toThrow(
      "Replay segment is too large after decoding.",
    );
  });

  it("waits for the first segment before loading later replay segments", async () => {
    const segment0 = buildSegment([
      encodeIngestBody(makeIndex("tab-a", 0, 1_000), await gzipJson([makeEvent(1_000, "first")])),
    ]);
    const segment1 = buildSegment([
      encodeIngestBody(makeIndex("tab-a", 1, 8_000), await gzipJson([makeEvent(8_000, "later")])),
    ]);
    const manifest = makeManifest(segment0.byteLength);
    manifest.endedAt = 10_000;
    manifest.durationMs = 9_000;
    manifest.segments = [
      manifest.segments[0]!,
      {
        key: "p/project/session/seg-000002.ors",
        bytes: segment1.byteLength,
        t0: 7_000,
        t1: 10_000,
        batches: 1,
      },
    ];

    let resolveFirstSegment: ((response: Response) => void) | undefined;
    const fetchCalls: string[] = [];
    const api = {
      baseUrl: "https://api.example.test",
      fetch: async (url: string | URL | Request) => {
        const requestUrl = requestUrlString(url);
        fetchCalls.push(requestUrl);
        if (requestUrl.endsWith("/manifest")) {
          return Response.json(manifest);
        }
        if (requestUrl.endsWith("/seg-000001.ors")) {
          return await new Promise<Response>((resolve) => {
            resolveFirstSegment = resolve;
          });
        }
        if (requestUrl.endsWith("/seg-000002.ors")) {
          return new Response(segment1 as unknown as BodyInit, {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    };

    const container = document.createElement("div");
    document.body.append(container);
    const player = new OrangePlayer(container, {
      api,
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
      worker: { allowSynchronousFallback: true },
    });

    await player.ready();
    await waitFor(() => resolveFirstSegment !== undefined);
    const seekPromise = player.seek(8_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCalls.some((url) => url.endsWith("/seg-000002.ors"))).toBe(false);

    resolveFirstSegment?.(
      new Response(segment0 as unknown as BodyInit, {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    await seekPromise;
    await waitFor(() => fetchCalls.some((url) => url.endsWith("/seg-000002.ors")));
    player.destroy();
    container.remove();
  });

  it("mints live tickets with bearer auth and uses ticket socket URLs", async () => {
    const fetchCalls: Array<{ url: string; headers: Headers; method?: string }> = [];
    const api = {
      baseUrl: "https://api.example.test",
      fetch: async (url: string | URL | Request, _init?: RequestInit) => {
        fetchCalls.push({
          url: requestUrlString(url),
          headers: new Headers(_init?.headers),
          method: _init?.method,
        });
        return Response.json({ ticket: "ticket-1", expiresAt: 1234 });
      },
    };

    const ticket = await mintLiveTicket(api, {
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
    });
    const socketUrl = liveSocketUrl(api, {
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
      ticket: ticket.ticket,
    });

    expect(ticket).toEqual({ ticket: "ticket-1", expiresAt: 1234 });
    expect(fetchCalls).toEqual([
      {
        url: "https://api.example.test/api/v1/projects/project/sessions/session/live-ticket",
        headers: expect.any(Headers),
        method: "POST",
      },
    ]);
    expect(fetchCalls[0]?.headers.get("authorization")).toBe("Bearer dev-token");
    expect(socketUrl).toBe(
      "wss://api.example.test/api/v1/projects/project/sessions/session/live?ticket=ticket-1",
    );
  });

  it("mints a fresh live ticket on reconnect", async () => {
    const sockets: FakeWebSocket[] = [];
    const ticketUrls: string[] = [];
    const api = {
      baseUrl: "https://api.example.test",
      fetch: async (url: string | URL | Request) => {
        const requestUrl = requestUrlString(url);
        if (requestUrl.endsWith("/manifest")) {
          return Response.json(makeManifest(0));
        }
        if (requestUrl.endsWith("/live-ticket")) {
          ticketUrls.push(requestUrl);
          return Response.json({
            ticket: `ticket-${ticketUrls.length}`,
            expiresAt: Date.now() + 60_000,
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    };
    class FakeWebSocket {
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(readonly url: string) {
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }

      close(): void {
        this.onclose?.();
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const container = document.createElement("div");
    document.body.append(container);
    const player = new OrangePlayer(container, {
      api,
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
      worker: { allowSynchronousFallback: true },
    });

    await player.ready();
    player.follow();
    await waitFor(() => sockets.length === 1);
    sockets[0]?.close();
    await waitFor(() => sockets.length === 2, 2_000);
    player.destroy();
    container.remove();

    expect(ticketUrls).toEqual([
      "https://api.example.test/api/v1/projects/project/sessions/session/live-ticket",
      "https://api.example.test/api/v1/projects/project/sessions/session/live-ticket",
    ]);
    expect(sockets.map((socket) => socket.url)).toEqual([
      "wss://api.example.test/api/v1/projects/project/sessions/session/live?ticket=ticket-1",
      "wss://api.example.test/api/v1/projects/project/sessions/session/live?ticket=ticket-2",
    ]);
  });
});

async function gzipJson(events: readonly ReplayEvent[]): Promise<Uint8Array> {
  const body = new Response(encoder.encode(JSON.stringify(events))).body;
  if (body === null) {
    throw new Error("test gzip body missing");
  }

  return new Uint8Array(
    await new Response(body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
}

function makeManifest(segmentBytes: number): SessionManifest {
  return {
    v: 1,
    sessionId: "session",
    projectId: "project",
    orgId: "org",
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    segments: [
      {
        key: "p/project/session/seg-000001.ors",
        bytes: segmentBytes,
        t0: 1_000,
        t1: 2_000,
        batches: 1,
      },
    ],
    timeline: [{ t: 1_100, k: "click" }],
    counts: { batches: 1, events: 1, clicks: 1, errors: 0, rages: 0, navs: 0 },
    bytes: segmentBytes,
    flags: 0,
    attrs: {},
  };
}

function makeEvent(timestamp: number, name: string): ReplayEvent {
  return { type: 0, timestamp, data: { name } } as ReplayEvent;
}

function makeIndex(tab: string, seq: number, time: number): BatchIndex {
  return {
    v: 1,
    s: "session",
    tab,
    seq,
    t0: time,
    t1: time,
    e: [{ t: time, k: "custom", d: tab }],
  };
}

function requestUrlString(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url;
  }

  if (url instanceof URL) {
    return url.toString();
  }

  return url.url;
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("condition did not pass in time");
}
