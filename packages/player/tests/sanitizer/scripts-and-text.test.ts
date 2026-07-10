import { describe, expect, it } from "vite-plus/test";
import {
  createReplaySanitizerState,
  sanitizeReplayEvents,
  type ReplayEvent,
} from "./test-helpers.ts";

describe("replay event sanitizer: scripts and text", () => {
  it("rewrites script elements and blanks inline script text", () => {
    const event = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: "div",
          attributes: {},
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: "script",
              attributes: {
                src: "https://internal.example/app.js",
                type: "module",
              },
              childNodes: [
                {
                  type: 3,
                  id: 3,
                  textContent: "fetch('https://internal.example/secret')",
                },
              ],
            },
          ],
        },
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const root = (sanitized.data as { node: Record<string, unknown> }).node;
    const children = root["childNodes"] as Array<Record<string, unknown>>;
    const script = children[0] as { tagName: string; attributes: Record<string, unknown> };
    const scriptChildren = children[0]?.["childNodes"] as Array<Record<string, string>>;

    expect(script.tagName).toBe("noscript");
    expect(script.attributes).toEqual({});
    expect(scriptChildren[0]?.textContent).toBe("");
  });

  it("rewrites added script nodes before replay", () => {
    const mutation = {
      type: 3,
      timestamp: 1_001,
      data: {
        source: 0,
        adds: [
          {
            parentId: 1,
            node: {
              type: 2,
              id: 2,
              tagName: "script",
              attributes: { nonce: "abc" },
              childNodes: [{ type: 3, id: 3, textContent: "alert(1)" }],
            },
          },
        ],
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([mutation]);
    const data = sanitized[0]!.data as {
      adds: Array<{
        node: {
          tagName: string;
          attributes: Record<string, unknown>;
          childNodes: Array<{ textContent: string }>;
        };
      }>;
    };
    const node = data.adds[0]?.node;

    expect(node?.tagName).toBe("noscript");
    expect(node?.attributes).toEqual({});
    expect(node?.childNodes[0]?.textContent).toBe("");
  });

  it("keeps script text and attributes blank across split mutations", () => {
    const fullSnapshot = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: "script",
          attributes: {},
          childNodes: [{ type: 3, id: 2, textContent: "" }],
        },
      },
    } as unknown as ReplayEvent;
    const textMutation = {
      type: 3,
      timestamp: 1_001,
      data: {
        source: 0,
        texts: [{ id: 2, value: "alert(1)" }],
      },
    } as unknown as ReplayEvent;
    const attributeMutation = {
      type: 3,
      timestamp: 1_002,
      data: {
        source: 0,
        attributes: [{ id: 1, attributes: { src: "https://internal.example/app.js" } }],
      },
    } as unknown as ReplayEvent;

    const state = createReplaySanitizerState();
    sanitizeReplayEvents([fullSnapshot], state);
    const sanitizedText = sanitizeReplayEvents([textMutation], state);
    const sanitizedAttributes = sanitizeReplayEvents([attributeMutation], state);
    const textData = sanitizedText[0]?.data as { texts: Array<{ value: string }> };
    const attributeData = sanitizedAttributes[0]?.data as {
      attributes: Array<{ attributes: Record<string, unknown> }>;
    };

    expect(textData.texts[0]?.value).toBe("");
    expect(attributeData.attributes[0]?.attributes).toEqual({});
  });

  it("keeps added text nodes under normal recorded elements", () => {
    const fullSnapshot = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: "div",
          attributes: {},
          childNodes: [],
        },
      },
    } as unknown as ReplayEvent;
    const mutation = {
      type: 3,
      timestamp: 1_001,
      data: {
        source: 0,
        adds: [
          {
            parentId: 1,
            node: {
              type: 3,
              id: 2,
              textContent: "Loaded dynamically",
            },
          },
        ],
      },
    } as unknown as ReplayEvent;

    const state = createReplaySanitizerState();
    sanitizeReplayEvents([fullSnapshot], state);
    const sanitized = sanitizeReplayEvents([mutation], state);
    const mutationData = sanitized[0]?.data as {
      adds: Array<{ node: { textContent: string } }>;
    };

    expect(mutationData.adds[0]?.node.textContent).toBe("Loaded dynamically");
  });

  it("keeps safe text mutations when the text node is known", () => {
    const fullSnapshot = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: "div",
          attributes: {},
          childNodes: [
            {
              type: 3,
              id: 2,
              textContent: "Before",
            },
          ],
        },
      },
    } as unknown as ReplayEvent;
    const mutation = {
      type: 3,
      timestamp: 1_001,
      data: {
        source: 0,
        texts: [
          {
            id: 2,
            value: "After",
          },
        ],
      },
    } as unknown as ReplayEvent;

    const state = createReplaySanitizerState();
    sanitizeReplayEvents([fullSnapshot], state);
    const sanitized = sanitizeReplayEvents([mutation], state);
    const mutationData = sanitized[0]?.data as { texts: Array<{ value: string }> };

    expect(mutationData.texts[0]?.value).toBe("After");
  });
});
