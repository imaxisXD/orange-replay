import { createSecureReplayer } from "../../../packages/player/src/secure-replayer.ts";
import { sanitizeReplayEvents } from "../../../packages/player/src/sanitize.ts";
import type { ReplayEvent } from "../../../packages/player/src/types.ts";

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
