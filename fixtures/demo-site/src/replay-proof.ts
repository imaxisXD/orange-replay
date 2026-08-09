import { createSecureReplayer } from "../../../packages/player/src/secure-replayer.ts";
import {
  createReplaySanitizerState,
  sanitizeReplayEvents,
} from "../../../packages/player/src/sanitize.ts";
import { ReplayAssetStore } from "../../../packages/player/src/replay-assets.ts";
import type { PlayerApi, ReplayEvent } from "../../../packages/player/src/types.ts";

const assetOrigin = "https://assets.customer.test";
const stylesheetHash = "a".repeat(64);
const fontHash = "b".repeat(64);
const backgroundHash = "c".repeat(64);
const replayBackgroundUrl = new URL("../../../landing/favicon-32x32.png", import.meta.url).href;
const replayFontUrl = new URL("../../../landing/fonts/DepartureMono-Regular.woff2", import.meta.url)
  .href;

export function mountReplayProof(root: HTMLElement): void {
  const events = sanitizeReplayEvents(buildReplayEvents());
  const replayer = createSecureReplayer(events, {
    root,
    showWarning: false,
    showDebug: false,
    mouseTail: false,
    useVirtualDom: true,
  });
  replayer.pause(0);
}

export async function mountReplayAssetProof(root: HTMLElement): Promise<void> {
  const [fontBytes, backgroundBytes] = await Promise.all([
    fetchBytes(replayFontUrl),
    fetchBytes(replayBackgroundUrl),
  ]);
  const stylesheet = `
    @font-face {
      font-family: "Replay asset font";
      src: url("${assetOrigin}/font.woff2") format("woff2");
      font-weight: 400;
    }
    .asset-card {
      min-height: 180px;
      padding: 28px;
      border: 2px solid rgb(245, 158, 11);
      border-radius: 12px;
      color: rgb(241, 245, 249);
      background-color: rgb(30, 41, 59);
      background-image: url("${assetOrigin}/background.png");
      background-repeat: no-repeat;
      background-position: right 20px bottom 20px;
      font-family: "Replay asset font", monospace;
    }
  `;
  const stylesheetBytes = new TextEncoder().encode(stylesheet);
  const bytesByHash = new Map<string, Uint8Array>([
    [stylesheetHash, stylesheetBytes],
    [fontHash, fontBytes],
    [backgroundHash, backgroundBytes],
  ]);
  const api: PlayerApi = {
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/replay-assets") {
        return Response.json({
          version: 1,
          entries: [
            {
              sourceUrl: `${assetOrigin}/replay.css`,
              parentHash: "",
              assetHash: stylesheetHash,
              contentType: "text/css",
              bytes: stylesheetBytes.byteLength,
              kind: "stylesheet",
            },
            {
              sourceUrl: `${assetOrigin}/font.woff2`,
              parentHash: stylesheetHash,
              assetHash: fontHash,
              contentType: "font/woff2",
              bytes: fontBytes.byteLength,
              kind: "font",
            },
            {
              sourceUrl: `${assetOrigin}/background.png`,
              parentHash: stylesheetHash,
              assetHash: backgroundHash,
              contentType: "image/png",
              bytes: backgroundBytes.byteLength,
              kind: "image",
            },
          ],
        });
      }
      const assetHash = url.split("/").at(-1) ?? "";
      const bytes = bytesByHash.get(assetHash);
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(bytes as unknown as BodyInit);
    },
    assetMapUrl: () => "/replay-assets",
    assetUrl: ({ assetHash }) => `/replay-assets/${assetHash}`,
  };
  const assetStore = new ReplayAssetStore(
    api,
    { projectId: "project", sessionId: "session" },
    new AbortController().signal,
  );
  await assetStore.load();
  const events = sanitizeReplayEvents(buildReplayAssetEvents(), createReplaySanitizerState(), {
    rewriteUrl: assetStore.rewriteUrl,
  });
  const replayer = createSecureReplayer(events, {
    root,
    showWarning: false,
    showDebug: false,
    mouseTail: false,
    useVirtualDom: true,
  });
  replayer.pause(0);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load a replay fidelity test asset.");
  return new Uint8Array(await response.arrayBuffer());
}

function buildReplayEvents(): ReplayEvent[] {
  return [
    {
      type: 4,
      timestamp: 1_000,
      data: { href: "https://recorded.example/dashboard", width: 1_000, height: 700 },
    },
    {
      type: 2,
      timestamp: 1_001,
      data: {
        initialOffset: { left: 0, top: 0 },
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: "html",
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 3,
                  tagName: "head",
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 4,
                      tagName: "style",
                      attributes: {},
                      childNodes: [
                        {
                          type: 3,
                          id: 5,
                          isStyle: true,
                          textContent: `
                            body { margin: 0; color: rgb(241, 245, 249); background: rgb(15, 23, 42); font-family: Arial, sans-serif; }
                            .layout { display: grid; grid-template-columns: 240px 1fr; gap: 24px; padding: 32px; }
                            .card { min-height: 180px; padding: 28px; border: 2px solid rgb(245, 158, 11); border-radius: 12px; background: rgb(30, 41, 59); }
                          `,
                        },
                      ],
                    },
                  ],
                },
                {
                  type: 2,
                  id: 6,
                  tagName: "body",
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 7,
                      tagName: "main",
                      attributes: { class: "layout" },
                      childNodes: [
                        {
                          type: 2,
                          id: 8,
                          tagName: "aside",
                          attributes: { class: "card" },
                          childNodes: [{ type: 3, id: 9, textContent: "Navigation" }],
                        },
                        {
                          type: 2,
                          id: 10,
                          tagName: "section",
                          attributes: { class: "card" },
                          childNodes: [{ type: 3, id: 11, textContent: "Replay fidelity proof" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  ] as unknown as ReplayEvent[];
}

function buildReplayAssetEvents(): ReplayEvent[] {
  return [
    {
      type: 4,
      timestamp: 2_000,
      data: { href: "https://recorded.example/dashboard", width: 1_000, height: 700 },
    },
    {
      type: 2,
      timestamp: 2_001,
      data: {
        initialOffset: { left: 0, top: 0 },
        node: {
          type: 0,
          id: 20,
          childNodes: [
            {
              type: 2,
              id: 21,
              tagName: "html",
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 22,
                  tagName: "head",
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 23,
                      tagName: "link",
                      attributes: { rel: "stylesheet", href: `${assetOrigin}/replay.css` },
                      childNodes: [],
                    },
                  ],
                },
                {
                  type: 2,
                  id: 24,
                  tagName: "body",
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 25,
                      tagName: "main",
                      attributes: { class: "asset-card" },
                      childNodes: [{ type: 3, id: 26, textContent: "Replay asset fidelity proof" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  ] as unknown as ReplayEvent[];
}
