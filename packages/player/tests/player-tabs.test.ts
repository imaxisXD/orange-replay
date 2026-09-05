// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionManifest } from "@orange-replay/shared/types";
import { OrangePlayer } from "../src/player.ts";
import { ReplaySurface } from "../src/player/replay-surface.ts";
import { LiveFollowController, type LiveFollowHost } from "../src/player/live-follow-controller.ts";
import type { ReplayEvent } from "../src/types.ts";

afterEach(() => vi.restoreAllMocks());

describe("tab selection during finalization", () => {
  it("keeps the live tab and publishes the saved checkpoint choices at handoff", async () => {
    const initial: SessionManifest = {
      v: 1,
      projectId: "project",
      sessionId: "session",
      orgId: "org",
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 1000,
      segments: [],
      timeline: [
        { t: 1000, k: "nav", tab: "tab-a", d: "/a" },
        { t: 1100, k: "nav", tab: "tab-b", d: "/b" },
      ],
      counts: { batches: 2, events: 2, clicks: 0, errors: 0, rages: 0, navs: 2 },
      bytes: 0,
      flags: 0,
      attrs: {},
    };
    let host: LiveFollowHost | undefined;
    vi.spyOn(LiveFollowController.prototype, "connect").mockImplementation(
      function (this: LiveFollowController) {
        host = (this as unknown as { options: { host: LiveFollowHost } }).options.host;
      },
    );
    vi.spyOn(ReplaySurface.prototype, "rebuild").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    const player = new OrangePlayer(container, {
      projectId: "project",
      sessionId: "session",
      api: {
        fetch: async (input) =>
          (typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          ).includes("manifest")
            ? Response.json(initial)
            : new Response(null, { status: 404 }),
      },
    });
    const tabsChanged = vi.fn();
    player.on("tabs", tabsChanged);
    try {
      await player.ready();
      player.follow();
      await vi.waitFor(() => expect(host).toBeDefined());
      const snapshot = {
        type: 2,
        timestamp: 1101,
        data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
      } as ReplayEvent;
      expect(host!.acceptsReplayTab("tab-b", [snapshot], false)).toBe(true);
      host!.onEvent({
        type: "snapshot",
        snapshot: {
          startedAt: 1000,
          endedAt: 2000,
          durationMs: 1000,
          timeline: initial.timeline,
          counts: initial.counts,
        },
      });
      host!.onEvent({ type: "events", events: [snapshot] });
      const final: SessionManifest = {
        ...initial,
        segments: [
          {
            key: "p/project/session/seg-000001.ors",
            bytes: 100,
            t0: 1000,
            t1: 2000,
            batches: 2,
            checkpoints: [
              { tab: "tab-a", timestamp: 1001, batch: 0 },
              { tab: "tab-b", timestamp: 1101, batch: 1 },
            ],
          },
        ],
      };
      player.finishLive(final);
      expect(player.getSelectedTab()).toBe("tab-b");
      expect(player.getTabs().map((tab) => tab.firstSnapshotAt)).toEqual([1001, 1101]);
      expect(tabsChanged.mock.lastCall?.[0]).toMatchObject({
        selectedTab: "tab-b",
        tabs: [
          { id: "tab-a", firstSnapshotAt: 1001 },
          { id: "tab-b", firstSnapshotAt: 1101 },
        ],
      });
    } finally {
      player.destroy();
      container.remove();
    }
  });
});
