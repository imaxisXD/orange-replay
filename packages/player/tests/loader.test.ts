// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BatchIndex, SessionManifest } from "@orange-replay/shared/types";
import { buildSegment, encodeIngestBody } from "@orange-replay/shared/wire";
import {
  fetchSegmentBytes,
  liveSocketUrl,
  loadSession,
  MAX_ENCODED_SEGMENT_BYTES,
  mintLiveTicket,
  readResponseBytesCapped,
} from "../src/api.ts";
import { OrangePlayer } from "../src/player.ts";
import {
  decodeSegmentBatches,
  decodeSegmentEvents,
  MAX_DECODED_SEGMENT_EVENTS,
  MAX_DECODED_SEGMENT_EVENT_BYTES,
} from "../src/segments.ts";
import type { ReplayEvent } from "../src/types.ts";
import { DecodeWorkerHost } from "../src/worker-host.ts";
import { EventType, IncrementalSource } from "rrweb";

const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("manifest and segment loading", () => {
  it("does not continue loading segments after the player is destroyed", async () => {
    let resolveManifest: ((response: Response) => void) | undefined;
    let segmentFetches = 0;
    let readyEvents = 0;
    const manifest = makeManifest(10);
    const api = {
      fetch: async (url: string | URL | Request) => {
        const requestUrl = requestUrlString(url);
        if (requestUrl.endsWith("/manifest")) {
          return await new Promise<Response>((resolve) => {
            resolveManifest = resolve;
          });
        }
        segmentFetches += 1;
        return new Response(new Uint8Array());
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const player = new OrangePlayer(container, {
      api,
      projectId: "project",
      sessionId: "session",
      worker: { allowSynchronousFallback: true },
    });
    player.on("ready", () => {
      readyEvents += 1;
    });

    player.destroy();
    resolveManifest?.(Response.json(manifest));
    await player.ready();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(segmentFetches).toBe(0);
    expect(readyEvents).toBe(0);
    container.remove();
  });

  it("returns a clear error instead of buffering forever when replay data is empty", async () => {
    const manifest = makeManifest(0);
    manifest.segments = [];
    manifest.timeline = [];
    const api = {
      fetch: async () => Response.json(manifest),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const player = new OrangePlayer(container, {
      api,
      projectId: "project",
      sessionId: "session",
      worker: { allowSynchronousFallback: true },
    });
    const errors: string[] = [];
    player.on("error", (error) => errors.push(error.message));

    await player.ready();
    await expect(player.play()).rejects.toThrow("does not contain enough replay data");
    expect(errors).toContain("This session does not contain enough replay data to play.");

    player.destroy();
    container.remove();
  });

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

  it("rejects oversized or mismatched encoded segment responses before decoding", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2])));
    await expect(
      fetchSegmentBytes(
        { fetch: fetchMock },
        {
          projectId: "project",
          sessionId: "session",
          segment: {
            key: "p/project/session/seg-000001.ors",
            bytes: MAX_ENCODED_SEGMENT_BYTES + 1,
            t0: 1,
            t1: 2,
            batches: 1,
          },
        },
      ),
    ).rejects.toThrow("too large");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      fetchSegmentBytes(
        { fetch: async () => new Response(new Uint8Array([1, 2])) },
        {
          projectId: "project",
          sessionId: "session",
          segment: {
            key: "p/project/session/seg-000001.ors",
            bytes: 3,
            t0: 1,
            t1: 2,
            batches: 1,
          },
        },
      ),
    ).rejects.toThrow("does not match");
  });

  it("stops reading a streamed segment as soon as it crosses the byte limit", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
    );

    await expect(readResponseBytesCapped(response, 3)).rejects.toThrow("exceeds");
  });

  it("updates the player timeline with dead clicks after replay data decodes", async () => {
    const segment = buildSegment([
      await gzipJson([makeEvent(1_000, "start"), makeEvent(2_000, "observed")]),
    ]);
    const manifest = makeManifest(segment.byteLength);
    manifest.timeline = [{ t: 1_100, k: "click", m: { selector: "button.save-settings" } }];
    const api = {
      fetch: async (url: string | URL | Request) => {
        if (requestUrlString(url).endsWith("/manifest")) {
          return Response.json(manifest);
        }
        return new Response(segment as unknown as BodyInit, {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const player = new OrangePlayer(container, {
      api,
      projectId: "project",
      sessionId: "session",
      worker: { allowSynchronousFallback: true },
    });
    const deadClickCounts: number[] = [];
    player.on("timeline", (timeline) => deadClickCounts.push(timeline.counts.deadClicks));

    await player.ready();
    await waitFor(() => deadClickCounts.includes(1));

    expect(deadClickCounts.at(-1)).toBe(1);
    player.destroy();
    container.remove();
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

  it("mints live tickets with the same-origin session cookie when no token is set", async () => {
    const fetchCalls: Array<{ headers: Headers; method?: string }> = [];
    const api = {
      fetch: async (_url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ headers: new Headers(init?.headers), method: init?.method });
        return Response.json({ ticket: "session-ticket", expiresAt: 1234 });
      },
    };

    await expect(
      mintLiveTicket(api, { projectId: "project", sessionId: "session" }),
    ).resolves.toEqual({ ticket: "session-ticket", expiresAt: 1234 });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.method).toBe("POST");
    expect(fetchCalls[0]?.headers.get("authorization")).toBeNull();
  });

  it("mints a fresh live ticket on reconnect", async () => {
    const sockets: FakeWebSocket[] = [];
    const ticketUrls: string[] = [];
    const provisionalManifest = makeManifest(0);
    provisionalManifest.segments = [];
    provisionalManifest.timeline = [];
    const snapshotEvent = {
      type: EventType.FullSnapshot,
      timestamp: 1_100,
      data: {
        node: { id: 1, type: 0, childNodes: [] },
        initialOffset: { left: 0, top: 0 },
      },
    } as ReplayEvent;
    const firstLiveEvent = makeIncrementalEvent(1_200);
    const secondLiveEvent = makeIncrementalEvent(1_300);
    const historyFrame = await liveFrame(makeIndex("tab-live", 0, 1_100), [snapshotEvent]);
    const firstLiveFrame = await liveFrame(makeIndex("tab-live", 1, 1_200), [firstLiveEvent]);
    const secondLiveFrame = await liveFrame(makeIndex("tab-live", 2, 1_300), [secondLiveEvent]);
    const api = {
      baseUrl: "https://api.example.test",
      fetch: async (url: string | URL | Request) => {
        const requestUrl = requestUrlString(url);
        if (requestUrl.endsWith("/manifest")) {
          return Response.json(provisionalManifest);
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
    const liveIndexes: BatchIndex[] = [];
    const waitingStates: boolean[] = [];
    player.on("live_index", (index) => liveIndexes.push(index));
    player.on("waiting_keyframe", ({ waiting }) => waitingStates.push(waiting));

    await player.ready();
    player.follow();
    await waitFor(() => sockets.length === 1);
    sendLiveHello(sockets[0], 1);
    sockets[0]?.onmessage?.({ data: historyFrame });
    sockets[0]?.onmessage?.({ data: firstLiveFrame });
    await waitFor(
      () => liveIndexes.length === 1 && waitingStates.filter((value) => !value).length === 1,
    );
    sockets[0]?.close();
    await waitFor(() => sockets.length === 2, 2_000);
    sendLiveHello(sockets[1], 2);
    sockets[1]?.onmessage?.({ data: historyFrame });
    sockets[1]?.onmessage?.({ data: firstLiveFrame });
    sockets[1]?.onmessage?.({ data: secondLiveFrame });
    await waitFor(
      () => liveIndexes.length === 2 && waitingStates.filter((value) => !value).length === 2,
    );
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
    expect(liveIndexes.map((index) => index.seq)).toEqual([1, 2]);
  });

  it("loads earlier live segments and adopts the final manifest without a new player", async () => {
    const fullSnapshot = {
      type: EventType.FullSnapshot,
      timestamp: 1_100,
      data: {
        node: { id: 1, type: 0, childNodes: [] },
        initialOffset: { left: 0, top: 0 },
      },
    } as ReplayEvent;
    const batchIndex: BatchIndex = {
      ...makeIndex("tab-live", 0, 1_100),
      checkpointTimestamps: [1_100],
    };
    const segmentBytes = buildSegment([
      encodeIngestBody(batchIndex, await gzipJson([makeMetaEvent(1_050), fullSnapshot])),
    ]);
    const finalManifest = makeManifest(segmentBytes.byteLength);
    finalManifest.segments[0] = {
      ...finalManifest.segments[0]!,
      checkpoints: [{ timestamp: 1_100, tab: "tab-live", batch: 0 }],
    };
    const provisionalManifest = makeManifest(0);
    provisionalManifest.endedAt = provisionalManifest.startedAt;
    provisionalManifest.durationMs = 0;
    provisionalManifest.segments = [];
    provisionalManifest.timeline = [];
    provisionalManifest.counts = {
      batches: 0,
      events: 0,
      clicks: 0,
      errors: 0,
      rages: 0,
      navs: 0,
    };
    provisionalManifest.bytes = 0;

    const sockets: LiveTestWebSocket[] = [];
    const segmentRequests: string[] = [];
    const api = {
      baseUrl: "https://api.example.test",
      fetch: async (url: string | URL | Request) => {
        const requestUrl = requestUrlString(url);
        if (requestUrl.endsWith("/manifest")) {
          return Response.json(provisionalManifest);
        }
        if (requestUrl.endsWith("/live-ticket")) {
          return Response.json({ ticket: "ticket-live", expiresAt: Date.now() + 60_000 });
        }
        if (requestUrl.endsWith("/seg-000001.ors")) {
          segmentRequests.push(requestUrl);
          return new Response(segmentBytes as unknown as BodyInit, {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    };
    class LiveTestWebSocket {
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;

      constructor(readonly url: string) {
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }

      close(): void {
        this.onclose?.({ code: 1000 });
      }
    }
    vi.stubGlobal("WebSocket", LiveTestWebSocket);

    const container = document.createElement("div");
    document.body.append(container);
    const player = new OrangePlayer(container, {
      api,
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
      worker: { allowSynchronousFallback: true },
    });
    const waitingStates: boolean[] = [];
    const liveStates: boolean[] = [];
    const liveIndexes: BatchIndex[] = [];
    const finalManifests: SessionManifest[] = [];
    const liveErrors: string[] = [];
    player.on("waiting_keyframe", ({ waiting }) => waitingStates.push(waiting));
    player.on("live", ({ following }) => liveStates.push(following));
    player.on("live_index", (index) => liveIndexes.push(index));
    player.on("live_finalized", (manifest) => finalManifests.push(manifest));
    player.on("error", ({ message, error }) =>
      liveErrors.push(error instanceof Error ? `${message}: ${error.message}` : message),
    );

    await player.ready();
    player.follow();
    await waitFor(() => sockets.length === 1);
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "hello",
        sessionId: "session",
        startedAt: 1_000,
        segments: finalManifest.segments,
        pendingBatches: 1,
        snapshot: {
          startedAt: 1_000,
          endedAt: 1_100,
          durationMs: 100,
          timeline: [],
          counts: {
            batches: 1,
            events: 1,
            clicks: 0,
            errors: 0,
            rages: 0,
            navs: 0,
          },
        },
      }),
    });
    const historyFrame = await liveFrame(makeIndex("tab-live", 1, 1_200), [
      makeIncrementalEvent(1_200),
    ]);
    const nextLiveFrame = await liveFrame(makeIndex("tab-live", 2, 1_300), [
      makeIncrementalEvent(1_300),
    ]);
    sockets[0]?.onmessage?.({ data: historyFrame });
    sockets[0]?.onmessage?.({ data: nextLiveFrame });
    await waitFor(() => segmentRequests.length === 1 && waitingStates.includes(false));
    expect(liveErrors).toEqual([]);
    expect(liveIndexes.map((index) => index.seq)).toEqual([2]);

    sockets[0]?.onmessage?.({
      data: JSON.stringify({ type: "finalized", manifest: finalManifest }),
    });
    await waitFor(() => finalManifests.length === 1 && liveStates.includes(false));

    expect(finalManifests).toEqual([finalManifest]);
    expect(await player.ready()).toEqual(finalManifest);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(segmentRequests).toHaveLength(1);
    await player.seek(0);
    expect(segmentRequests).toHaveLength(2);

    player.destroy();
    container.remove();
  });

  it("seeks all flushed live segments and keeps the pending tail during idle review", async () => {
    const firstFullSnapshot = {
      type: EventType.FullSnapshot,
      timestamp: 1_100,
      data: {
        node: { id: 1, type: 0, childNodes: [] },
        initialOffset: { left: 0, top: 0 },
      },
    } as ReplayEvent;
    const secondFullSnapshot = {
      ...firstFullSnapshot,
      timestamp: 5_100,
    } as ReplayEvent;
    const firstBatchIndex: BatchIndex = {
      ...makeIndex("tab-live", 0, 1_100),
      checkpointTimestamps: [1_100],
    };
    const secondBatchIndex: BatchIndex = {
      ...makeIndex("tab-live", 1, 5_100),
      checkpointTimestamps: [5_100],
    };
    const firstSegmentBytes = buildSegment([
      encodeIngestBody(firstBatchIndex, await gzipJson([makeMetaEvent(1_050), firstFullSnapshot])),
    ]);
    const secondSegmentBytes = buildSegment([
      encodeIngestBody(
        secondBatchIndex,
        await gzipJson([makeMetaEvent(5_050), secondFullSnapshot]),
      ),
    ]);
    const finalManifest = makeManifest(firstSegmentBytes.byteLength);
    finalManifest.endedAt = 6_500;
    finalManifest.durationMs = 5_500;
    finalManifest.segments = [
      {
        key: "p/project/session/seg-000001.ors",
        bytes: firstSegmentBytes.byteLength,
        t0: 1_000,
        t1: 3_000,
        batches: 1,
        checkpoints: [{ timestamp: 1_100, tab: "tab-live", batch: 0 }],
      },
      {
        key: "p/project/session/seg-000002.ors",
        bytes: secondSegmentBytes.byteLength,
        t0: 5_000,
        t1: 6_000,
        batches: 1,
        checkpoints: [{ timestamp: 5_100, tab: "tab-live", batch: 0 }],
      },
    ];
    finalManifest.bytes = firstSegmentBytes.byteLength + secondSegmentBytes.byteLength;
    const provisionalManifest = makeManifest(0);
    provisionalManifest.endedAt = provisionalManifest.startedAt;
    provisionalManifest.durationMs = 0;
    provisionalManifest.segments = [];
    provisionalManifest.timeline = [];
    provisionalManifest.bytes = 0;
    const reviewManifest = {
      ...provisionalManifest,
      endedAt: 6_500,
      durationMs: 5_500,
    };

    const sockets: ReviewWebSocket[] = [];
    const segmentRequests: string[] = [];
    const api = {
      baseUrl: "https://api.example.test",
      fetch: async (url: string | URL | Request) => {
        const requestUrl = requestUrlString(url);
        if (requestUrl.endsWith("/manifest")) return Response.json(provisionalManifest);
        if (requestUrl.endsWith("/live-ticket")) {
          return Response.json({ ticket: "ticket-review", expiresAt: Date.now() + 60_000 });
        }
        if (requestUrl.endsWith("/seg-000001.ors")) {
          segmentRequests.push(requestUrl);
          return new Response(firstSegmentBytes as unknown as BodyInit, {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        if (requestUrl.endsWith("/seg-000002.ors")) {
          segmentRequests.push(requestUrl);
          return new Response(secondSegmentBytes as unknown as BodyInit, {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    };
    class ReviewWebSocket {
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;

      constructor(readonly url: string) {
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }

      close(): void {
        this.onclose?.({ code: 1000 });
      }
    }
    vi.stubGlobal("WebSocket", ReviewWebSocket);

    const container = document.createElement("div");
    document.body.append(container);
    const player = new OrangePlayer(container, {
      api,
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
      worker: { allowSynchronousFallback: true },
    });
    const followingStates: boolean[] = [];
    const finalizedManifests: SessionManifest[] = [];
    const errors: string[] = [];
    player.on("live", ({ following }) => followingStates.push(following));
    player.on("live_finalized", (manifest) => finalizedManifests.push(manifest));
    player.on("error", ({ error, message }) =>
      errors.push(error instanceof Error ? `${message}: ${error.message}` : message),
    );

    await player.ready();
    player.follow();
    await waitFor(() => sockets.length === 1);
    player.reviewLiveHistory(reviewManifest);
    await waitFor(() => sockets.length === 2);
    sockets[1]?.onmessage?.({
      data: JSON.stringify({
        type: "hello",
        sessionId: "session",
        startedAt: 1_000,
        segments: finalManifest.segments,
        pendingBatches: 1,
        snapshot: {
          startedAt: 1_000,
          endedAt: 6_200,
          durationMs: 5_200,
          timeline: [],
          counts: {
            batches: 3,
            events: 5,
            clicks: 0,
            errors: 0,
            rages: 0,
            navs: 0,
          },
        },
      }),
    });
    sockets[1]?.onmessage?.({
      data: await liveFrame(makeIndex("tab-live", 2, 6_200), [makeIncrementalEvent(6_200)]),
    });

    await waitFor(() => followingStates.at(-1) === false && segmentRequests.length === 1);
    expect(finalizedManifests).toEqual([]);
    expect(await player.ready()).toEqual({
      ...reviewManifest,
      bytes: finalManifest.bytes,
      segments: finalManifest.segments,
    });
    expect(segmentRequests[0]).toContain("seg-000002.ors");

    await player.seek(100);
    expect(segmentRequests.filter((url) => url.endsWith("/seg-000001.ors"))).toHaveLength(1);

    await player.seek(5_200);
    expect(
      segmentRequests.filter((url) => url.endsWith("/seg-000002.ors")).length,
    ).toBeGreaterThanOrEqual(2);
    await player.play();
    expect(errors).toEqual([]);

    player.finishLive(finalManifest);
    expect(finalizedManifests).toEqual([]);
    expect(await player.ready()).toEqual(finalManifest);
    await player.seek(0);
    expect(segmentRequests.filter((url) => url.endsWith("/seg-000001.ors"))).toHaveLength(2);

    player.destroy();
    container.remove();
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

async function liveFrame(index: BatchIndex, events: readonly ReplayEvent[]): Promise<ArrayBuffer> {
  return new Uint8Array(encodeIngestBody(index, await gzipJson(events))).buffer;
}

function sendLiveHello(
  socket: { onmessage: ((event: { data: unknown }) => void) | null } | undefined,
  pendingBatches: number,
): void {
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "hello",
      sessionId: "session",
      startedAt: 1_000,
      segments: [],
      pendingBatches,
      snapshot: {
        startedAt: 1_000,
        endedAt: 1_300,
        durationMs: 300,
        timeline: [],
        counts: {
          batches: pendingBatches,
          events: pendingBatches,
          clicks: 0,
          errors: 0,
          rages: 0,
          navs: 0,
        },
      },
    }),
  });
}

function makeIncrementalEvent(timestamp: number): ReplayEvent {
  return {
    type: EventType.IncrementalSnapshot,
    timestamp,
    data: { source: IncrementalSource.ViewportResize, width: 1_440, height: 900 },
  } as ReplayEvent;
}

function makeMetaEvent(timestamp: number): ReplayEvent {
  return {
    type: EventType.Meta,
    timestamp,
    data: { href: "https://example.test/", width: 1_440, height: 900 },
  } as ReplayEvent;
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
