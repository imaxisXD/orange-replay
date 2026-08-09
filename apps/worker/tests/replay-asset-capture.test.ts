import { manifestKey, type ReplayAssetCaptureMessage } from "@orange-replay/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  captureReplayAssets,
  collectReplayAssetCandidatesForTest,
  replayAssetMapKey,
} from "../src/replay-assets/capture.ts";
import type { Env } from "../src/env.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replay asset extraction", () => {
  it("finds public styles, nested CSS assets, and images from a full snapshot", () => {
    const candidates = collectReplayAssetCandidatesForTest(
      {
        type: 0,
        childNodes: [
          {
            type: 2,
            tagName: "link",
            attributes: { rel: "stylesheet", href: "/assets/app.css" },
            childNodes: [],
          },
          {
            type: 2,
            tagName: "style",
            attributes: {},
            childNodes: [{ type: 3, textContent: '@font-face{src:url("/fonts/app.woff2")}' }],
          },
          {
            type: 2,
            tagName: "img",
            attributes: {
              src: "images/hero.png",
              srcset: "/images/hero@2x.png 2x, data:image/png;base64,ignored 3x",
            },
            childNodes: [],
          },
        ],
      },
      "https://customer.com/checkout/",
    );

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawUrl: "/assets/app.css",
          fetchUrl: "https://customer.com/assets/app.css",
        }),
        expect.objectContaining({
          rawUrl: "/fonts/app.woff2",
          fetchUrl: "https://customer.com/fonts/app.woff2",
        }),
        expect.objectContaining({
          rawUrl: "images/hero.png",
          fetchUrl: "https://customer.com/checkout/images/hero.png",
        }),
        expect.objectContaining({
          rawUrl: "/images/hero@2x.png",
          fetchUrl: "https://customer.com/images/hero@2x.png",
        }),
      ]),
    );
    expect(candidates.some((candidate) => candidate.rawUrl.startsWith("data:"))).toBe(false);
  });

  it("caps each session at 64 unique asset candidates", () => {
    const candidates = collectReplayAssetCandidatesForTest(
      {
        type: 0,
        childNodes: Array.from({ length: 100 }, (_, index) => ({
          type: 2,
          tagName: "img",
          attributes: { src: `/images/${index}.png` },
          childNodes: [],
        })),
      },
      "https://customer.com/",
    );

    expect(candidates).toHaveLength(64);
  });

  it("writes an empty completion map without reading replay bytes when the project opts out", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const put = vi.fn(async () => ({ etag: "map" }));
    const get = vi.fn();
    const env = {
      IDX_00: {
        prepare: vi.fn(() => ({
          bind: () => ({ first: async () => ({ enabled: 0 }) }),
        })),
      },
      RECORDINGS: { get, head: async () => null, put },
    } as unknown as Env;
    const message = replayAssetMessage("disabled");

    await captureReplayAssets(message, env, 1);

    expect(get).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      replayAssetMapKey(message.projectId, message.sessionId),
      JSON.stringify({ version: 1, entries: [] }),
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } }),
    );
  });
});

function replayAssetMessage(name: string): ReplayAssetCaptureMessage {
  const projectId = `project-${name}`;
  const sessionId = `session-${name}`;
  return {
    type: "session.replay-assets",
    projectId,
    sessionId,
    shard: 0,
    requestId: `request-${name}`,
    manifestKey: manifestKey(projectId, sessionId),
    endedAt: Date.now(),
    retentionDays: 30,
  };
}
