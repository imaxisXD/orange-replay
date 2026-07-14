// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionManifest } from "@orange-replay/shared/types";
import { LiveFollowController, type LiveFollowHost } from "../src/player/live-follow-controller.ts";
import type { DecodeWorkerHost } from "../src/worker-host.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LiveFollowController", () => {
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
      request: { api, projectId: "project", sessionId: "session", token: "token" },
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
    controller.disconnect();
  });

  it("releases idle review when the fresh live ticket fails", async () => {
    let ticketRequests = 0;
    const errors: string[] = [];
    const host: LiveFollowHost = {
      ...makeHost([]),
      onError: (message) => errors.push(message),
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
        token: "token",
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
      onError: (message) => errors.push(message),
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
        token: "token",
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
});

function makeHost(finalized: SessionManifest[]): LiveFollowHost {
  return {
    isFollowing: () => true,
    isDestroyed: () => false,
    acceptsReplayTab: () => true,
    onLiveEvents: () => undefined,
    onLiveIndex: () => undefined,
    onLiveSnapshot: () => undefined,
    onSessionFinalized: (manifest) => finalized.push(manifest),
    onSessionEnded: () => undefined,
    onResetReplayEvents: () => undefined,
    onReconnectStarted: () => undefined,
    onKeyframeOverflow: () => undefined,
    onSocketOpen: () => undefined,
    onConnectionChanged: () => undefined,
    onWaitingChanged: () => undefined,
    onError: () => undefined,
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
