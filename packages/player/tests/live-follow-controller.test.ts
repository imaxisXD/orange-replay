// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BatchIndex, SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import { buildSegment, encodeIngestBody } from "@orange-replay/shared/wire";
import { EventType } from "rrweb";
import {
  LiveFollowController,
  retainedDecodedBytesForTab,
  type LiveFollowHost,
} from "../src/player/live-follow-controller.ts";
import type { ReplayEvent } from "../src/types.ts";
import type { DecodeWorkerHost } from "../src/worker-host.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LiveFollowController", () => {
  it("counts only the retained replay tab against the active byte budget", () => {
    expect(
      retainedDecodedBytesForTab(
        [
          { index: { tab: "tab-a" }, decodedBytes: 12 },
          { index: { tab: "tab-b" }, decodedBytes: 120_000_000 },
          { index: { tab: "tab-a" }, decodedBytes: 8 },
        ],
        "tab-a",
      ),
    ).toBe(20);
  });

  it("does not charge background tabs against loaded live history", async () => {
    const activeEvents = [
      {
        type: EventType.FullSnapshot,
        timestamp: 1_000,
        data: {
          node: { id: 1, type: 0, childNodes: [] },
          initialOffset: { left: 0, top: 0 },
        },
      } as ReplayEvent,
    ];
    const activeIndex: BatchIndex = {
      v: 1,
      s: "session",
      tab: "tab-active",
      seq: 0,
      t0: 1_000,
      t1: 1_000,
      e: [],
      checkpointTimestamps: [1_000],
    };
    const backgroundIndex = (seq: number): BatchIndex => ({
      v: 1,
      s: "session",
      tab: "tab-background",
      seq,
      t0: 1_000 + seq,
      t1: 1_000 + seq,
      e: [],
    });
    const segmentBytes = Array.from({ length: 5 }, (_unused, index) =>
      buildSegment(
        index === 0
          ? [
              encodeIngestBody(activeIndex, new Uint8Array([1])),
              encodeIngestBody(backgroundIndex(index), new Uint8Array([2])),
            ]
          : [encodeIngestBody(backgroundIndex(index), new Uint8Array([2]))],
      ),
    );
    const segments: SegmentRef[] = segmentBytes.map((bytes, index) => ({
      key: `p/project/session/seg-${index}.ors`,
      bytes: bytes.byteLength,
      t0: 1_000 + index,
      t1: 1_000 + index,
      batches: index === 0 ? 2 : 1,
      ...(index === 0 ? { checkpoints: [{ timestamp: 1_000, tab: "tab-active", batch: 0 }] } : {}),
    }));
    const sockets: HistoryWebSocket[] = [];
    const errors: string[] = [];
    const receivedEvents: ReplayEvent[][] = [];

    class HistoryWebSocket {
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
    vi.stubGlobal("WebSocket", HistoryWebSocket);

    const controller = new LiveFollowController({
      request: {
        api: {
          baseUrl: "https://api.example.test",
          fetch: async (url: string | URL | Request) => {
            const requestUrl =
              typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
            if (requestUrl.endsWith("/live-ticket")) {
              return Response.json({ ticket: "history-ticket", expiresAt: Date.now() + 60_000 });
            }
            const segmentIndex = segments.findIndex((segment) =>
              requestUrl.endsWith(`/${segment.key.split("/").at(-1)}`),
            );
            const bytes = segmentBytes[segmentIndex];
            return bytes === undefined
              ? Response.json({ error: "not_found" }, { status: 404 })
              : new Response(bytes as unknown as BodyInit);
          },
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker: {
        decodeBatchWithStats: async (payload: Uint8Array) =>
          payload[0] === 1
            ? { events: activeEvents, decodedBytes: 10 }
            : { events: [], decodedBytes: 30 * 1024 * 1024 },
      } as unknown as DecodeWorkerHost,
      host: {
        acceptsReplayTab: () => true,
        onEvent: (event) => {
          if (event.type === "error") errors.push(event.message);
          if (event.type === "events") receivedEvents.push([...event.events]);
        },
      },
    });

    controller.startFollowing();
    controller.connect();
    await waitFor(() => sockets.length === 1);
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "hello",
        sessionId: "session",
        startedAt: 1_000,
        segments,
        pendingBatches: 0,
        snapshot: {
          startedAt: 1_000,
          endedAt: 1_004,
          durationMs: 4,
          timeline: [],
          counts: { batches: 6, events: 1, clicks: 0, errors: 0, rages: 0, navs: 0 },
        },
      }),
    });
    await waitFor(() => receivedEvents.length === 1 || errors.length > 0);

    expect(errors).toEqual([]);
    expect(receivedEvents).toEqual([activeEvents]);
    controller.stopFollowing();
  });

  it("ignores a stale ticket and releases review when finalization arrives before hello", async () => {
    let finishFirstTicket: ((response: Response) => void) | undefined;
    let ticketRequests = 0;
    const sockets: TestWebSocket[] = [];
    const finalized: SessionManifest[] = [];
    const host = makeHost(finalized);
    const api = {
      baseUrl: "https://api.example.test",
      fetch: async (url: string | URL | Request) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (!requestUrl.endsWith("/live-ticket")) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        ticketRequests += 1;
        if (ticketRequests === 1) {
          return await new Promise<Response>((resolve) => {
            finishFirstTicket = resolve;
          });
        }
        return Response.json({ ticket: "fresh-ticket", expiresAt: Date.now() + 60_000 });
      },
    };
    class TestWebSocket {
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
    vi.stubGlobal("WebSocket", TestWebSocket);

    const controller = new LiveFollowController({
      request: { api, projectId: "project", sessionId: "session" },
      signal: new AbortController().signal,
      worker: {} as DecodeWorkerHost,
      host,
    });
    controller.startFollowing();
    controller.connect();
    await waitFor(() => ticketRequests === 1);

    const reviewReady = controller.refreshHistoryForReview();
    await waitFor(() => ticketRequests === 2 && sockets.length === 1);
    finishFirstTicket?.(Response.json({ ticket: "stale-ticket", expiresAt: Date.now() + 60_000 }));
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toContain("ticket=fresh-ticket");

    const manifest = makeManifest();
    sockets[0]?.onmessage?.({
      data: JSON.stringify({ type: "finalized", manifest }),
    });
    await reviewReady;

    expect(finalized).toEqual([manifest]);
    controller.stopFollowing();
  });

  it("releases idle review when the fresh live ticket fails", async () => {
    let ticketRequests = 0;
    const errors: string[] = [];
    const host: LiveFollowHost = {
      ...makeHost([]),
      onEvent: (event) => {
        if (event.type === "error") errors.push(event.message);
      },
    };
    const controller = new LiveFollowController({
      request: {
        api: {
          baseUrl: "https://api.example.test",
          fetch: async () => {
            ticketRequests += 1;
            return Response.json({ error: "ticket_unavailable" }, { status: 503 });
          },
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker: {} as DecodeWorkerHost,
      host,
    });

    controller.startFollowing();
    await controller.refreshHistoryForReview();
    const history = await controller.stopAndTakeReviewHistory();

    expect(ticketRequests).toBe(1);
    expect(errors).toContain("Could not create a live ticket.");
    expect(history).toEqual({ segments: [], tailEvents: [] });
  });

  it("bounds idle review when the refreshed socket never sends history", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const sockets: SilentWebSocket[] = [];
    const host: LiveFollowHost = {
      ...makeHost([]),
      onEvent: (event) => {
        if (event.type === "error") errors.push(event.message);
      },
    };
    class SilentWebSocket {
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number }) => void) | null = null;

      constructor(readonly url: string) {
        sockets.push(this);
      }

      close(): void {
        this.onclose?.({ code: 1000 });
      }
    }
    vi.stubGlobal("WebSocket", SilentWebSocket);
    const controller = new LiveFollowController({
      request: {
        api: {
          baseUrl: "https://api.example.test",
          fetch: async () =>
            Response.json({ ticket: "silent-ticket", expiresAt: Date.now() + 60_000 }),
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker: {} as DecodeWorkerHost,
      host,
    });

    controller.startFollowing();
    const reviewReady = controller.refreshHistoryForReview();
    await vi.advanceTimersByTimeAsync(3_000);
    await reviewReady;
    const history = await controller.stopAndTakeReviewHistory();

    expect(sockets).toHaveLength(1);
    expect(errors).toContain("Live history refresh took too long. Using replay already received.");
    expect(history).toEqual({ segments: [], tailEvents: [] });
  });

  it("bounds the complete encoded live-frame queue", async () => {
    let releaseFirstDecode: (() => void) | undefined;
    let decodeCalls = 0;
    const errors: string[] = [];
    const sockets: QueueWebSocket[] = [];

    class QueueWebSocket {
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

    vi.stubGlobal("WebSocket", QueueWebSocket);
    const controller = new LiveFollowController({
      request: {
        api: {
          baseUrl: "https://api.example.test",
          fetch: async () =>
            Response.json({ ticket: "queue-ticket", expiresAt: Date.now() + 60_000 }),
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker: {
        decodeBatchWithStats: async () => {
          decodeCalls += 1;
          if (decodeCalls === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstDecode = resolve;
            });
          }
          return { events: [], decodedBytes: 0 };
        },
      } as unknown as DecodeWorkerHost,
      host: {
        ...makeHost([]),
        onEvent: (event) => {
          if (event.type === "error") errors.push(event.message);
        },
      },
    });

    controller.startFollowing();
    controller.connect();
    await waitFor(() => sockets.length === 1);

    const largeDetail = "x".repeat(60_000);
    for (let seq = 0; seq < 400 && errors.length === 0; seq += 1) {
      const frame = encodeIngestBody(
        {
          v: 1,
          s: "session",
          tab: "tab-a",
          seq,
          t0: seq,
          t1: seq,
          e: [{ t: seq, k: "custom", d: largeDetail }],
        },
        new Uint8Array(),
      );
      sockets[0]?.onmessage?.({ data: frame.buffer });
    }

    expect(errors).toContain("Live replay arrived faster than it could be decoded.");
    await waitFor(() => releaseFirstDecode !== undefined);
    releaseFirstDecode?.();
    await controller.stopAndTakeReviewHistory();
  });

  it("drains a received frame before returning idle review history", async () => {
    let finishDecode: ((events: ReplayEvent[]) => void) | undefined;
    const sockets: HistoryWebSocket[] = [];
    const events = [
      {
        type: EventType.FullSnapshot,
        timestamp: 1_100,
        data: {
          node: { id: 1, type: 0, childNodes: [] },
          initialOffset: { left: 0, top: 0 },
        },
      } as ReplayEvent,
    ];
    class HistoryWebSocket {
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
    vi.stubGlobal("WebSocket", HistoryWebSocket);
    const controller = new LiveFollowController({
      request: {
        api: {
          baseUrl: "https://api.example.test",
          fetch: async () =>
            Response.json({ ticket: "history-ticket", expiresAt: Date.now() + 60_000 }),
        },
        projectId: "project",
        sessionId: "session",
      },
      signal: new AbortController().signal,
      worker: {
        decodeBatchWithStats: async () => ({
          events: await new Promise<ReplayEvent[]>((resolve) => {
            finishDecode = resolve;
          }),
          decodedBytes: 1,
        }),
      } as unknown as DecodeWorkerHost,
      host: makeHost([]),
    });

    controller.startFollowing();
    controller.connect();
    await waitFor(() => sockets.length === 1);
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "hello",
        sessionId: "session",
        startedAt: 1_000,
        segments: [],
        pendingBatches: 0,
        snapshot: {
          startedAt: 1_000,
          endedAt: 1_100,
          durationMs: 100,
          timeline: [],
          counts: { batches: 1, events: 1, clicks: 0, errors: 0, rages: 0, navs: 0 },
        },
      }),
    });
    const frame = encodeIngestBody(
      { v: 1, s: "session", tab: "tab-a", seq: 0, t0: 1_100, t1: 1_100, e: [] },
      new Uint8Array([1]),
    );
    sockets[0]?.onmessage?.({ data: frame.slice().buffer });
    await waitFor(() => finishDecode !== undefined);

    const historyPromise = controller.stopAndTakeReviewHistory();
    finishDecode?.(events);

    await expect(historyPromise).resolves.toEqual({ segments: [], tailEvents: events });
  });
});

function makeHost(finalized: SessionManifest[]): LiveFollowHost {
  return {
    acceptsReplayTab: () => true,
    onEvent: (event) => {
      if (event.type === "finalized") finalized.push(event.manifest);
    },
  };
}

function makeManifest(): SessionManifest {
  return {
    v: 1,
    sessionId: "session",
    projectId: "project",
    orgId: "org",
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    segments: [],
    timeline: [],
    counts: { batches: 1, events: 1, clicks: 0, errors: 0, rages: 0, navs: 0 },
    bytes: 0,
    flags: 0,
    attrs: {},
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not pass in time");
}
