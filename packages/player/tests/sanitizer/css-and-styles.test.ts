import { describe, expect, it } from "vite-plus/test";
import {
  createReplaySanitizerState,
  sanitizeReplayEvents,
  type ReplayEvent,
} from "./test-helpers.ts";

describe("replay event sanitizer: CSS and styles", () => {
  it("keeps visual CSS while removing recorded resource URLs", () => {
    const event = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          tagName: "div",
          attributes: {
            style: "color: red; background-image: url(https://internal.example/image.png);",
          },
          childNodes: [
            {
              type: 2,
              tagName: "img",
              attributes: {
                rr_src: "https://internal.example/original.png",
                rr_dataURL: "https://internal.example/canvas.png",
                alt: "Logo",
                src: "http://169.254.169.254/latest/meta-data",
                srcset: "https://internal.example/large.png 2x",
              },
            },
            {
              type: 2,
              tagName: "link",
              attributes: {
                href: "https://internal.example/app.css",
                rel: "stylesheet",
              },
            },
            {
              type: 2,
              tagName: "style",
              attributes: {},
              childNodes: [
                {
                  type: 3,
                  textContent:
                    '@import "https://internal.example/print.css"; body { background: url(http://127.0.0.1/a.png); }',
                },
              ],
            },
          ],
        },
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const root = (sanitized.data as { node: Record<string, unknown> }).node;
    const rootAttributes = root["attributes"] as Record<string, string>;
    const children = root["childNodes"] as Array<Record<string, unknown>>;
    const imageAttributes = children[0]?.["attributes"] as Record<string, string>;
    const linkAttributes = children[1]?.["attributes"] as Record<string, string>;
    const styleChildren = children[2]?.["childNodes"] as Array<Record<string, string>>;

    expect(rootAttributes["style"]).toBe("color:red;background-image:url(data:,)");
    expect(imageAttributes["alt"]).toBe("Logo");
    expect(imageAttributes["rr_src"]).toBe("");
    expect(imageAttributes["rr_dataURL"]).toBe("");
    expect(imageAttributes["src"]).toBe("");
    expect(imageAttributes["srcset"]).toBe("");
    expect(linkAttributes["href"]).toBe("");
    expect(styleChildren[0]?.["textContent"]).toBe("body{background:url(data:,)}");

    const originalRoot = (event.data as { node: Record<string, unknown> }).node;
    const originalChildren = originalRoot["childNodes"] as Array<Record<string, unknown>>;
    const originalImageAttributes = originalChildren[0]?.["attributes"] as Record<string, string>;
    expect(originalImageAttributes["src"]).toBe("http://169.254.169.254/latest/meta-data");
  });

  it("keeps stylesheet mutations while removing their external URLs", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 8,
        adds: [
          {
            rule: '@import "https://internal.example/a.css"; body { background: url(http://127.0.0.1/b.png); }',
            index: 0,
          },
        ],
        replaceSync: ".hero { background-image: url(https://internal.example/hero.png); }",
        replace: ".hero { background-image: \\75rl(https://internal.example/escaped.png); }",
        set: {
          property: "background-image",
          value: "url(http://127.0.0.1/private.png)",
        },
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const data = sanitized.data as {
      adds: Array<{ rule: string }>;
      replace: string;
      replaceSync: string;
      set: { value: string };
    };

    expect(data.adds[0]?.rule).toBe("body{background:url(data:,)}");
    expect(data.replace).toBe(".hero{background-image:url(data:,)}");
    expect(data.replaceSync).toBe(".hero{background-image:url(data:,)}");
    expect(data.set.value).toBe("url(data:,)");
  });

  it("removes dangerous replay fields even when values are not strings", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 8,
        adds: [
          {
            rule: ['@import "https://internal.example/a.css";'],
          },
        ],
        replaceSync: ["body { background: url(http://127.0.0.1/private.png); }"],
        set: {
          property: "background-image",
          value: ["url(http://127.0.0.1/private.png)"],
        },
        fontSource: ["url(https://internal.example/font.woff2)"],
        src: ["https://internal.example/image.png"],
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const data = sanitized.data as {
      adds: Array<{ rule: unknown }>;
      replaceSync: unknown;
      set: { value: unknown };
      fontSource: unknown;
      src: unknown;
    };

    expect(data.adds[0]?.rule).toEqual([""]);
    expect(data.replaceSync).toEqual(["body{background:url(data:,)}"]);
    expect(data.set.value).toEqual(["url(data:,)"]);
    expect(data.fontSource).toBe("");
    expect(data.src).toBe("");
  });

  it("removes stylesheet declaration values when the property name is not a string", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 8,
        set: {
          property: ["background-image"],
          value: "url(https://internal.example/pixel.png)",
          priority: ["important"],
        },
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const data = sanitized.data as { set: { property: unknown; value: string; priority: string } };

    expect(data.set.property).toBe("");
    expect(data.set.value).toBe("url(data:,)");
    expect(data.set.priority).toBe("");
  });

  it("keeps safe recorded text mutations inside style nodes", () => {
    const fullSnapshot = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: "style",
          attributes: {},
          childNodes: [
            {
              type: 3,
              id: 2,
              textContent: "body { color: red; }",
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
            value: '@import "https://internal.example/a.css";',
          },
        ],
      },
    } as unknown as ReplayEvent;

    const state = createReplaySanitizerState();
    sanitizeReplayEvents([fullSnapshot], state);
    const sanitized = sanitizeReplayEvents([mutation], state);
    const mutationData = sanitized[0]?.data as { texts: Array<{ value: string }> };

    expect(mutationData.texts[0]?.value).toBe("");
  });

  it("keeps added style text while removing its external URLs", () => {
    const fullSnapshot = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: "style",
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
              textContent: "body { background: url(http://127.0.0.1/private.png); }",
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

    expect(mutationData.adds[0]?.node.textContent).toBe("body{background:url(data:,)}");
  });

  it("keeps safe style text but removes script text when text nodes spoof a tag name", () => {
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
              type: 2,
              id: 2,
              tagName: "style",
              attributes: {},
              childNodes: [
                {
                  type: 3,
                  id: 3,
                  tagName: "div",
                  textContent: '@import "https://internal.example/a.css";',
                },
              ],
            },
            {
              type: 2,
              id: 4,
              tagName: "script",
              attributes: {},
              childNodes: [
                {
                  type: 3,
                  id: 5,
                  tagName: "span",
                  textContent: "fetch('https://internal.example/secret')",
                },
              ],
            },
          ],
        },
      },
    } as unknown as ReplayEvent;
    const textMutation = {
      type: 3,
      timestamp: 1_001,
      data: {
        source: 0,
        texts: [
          { id: 3, value: "body { background: url(http://127.0.0.1/private.png); }" },
          { id: 5, value: "alert(1)" },
        ],
      },
    } as unknown as ReplayEvent;
    const state = createReplaySanitizerState();

    const sanitizedSnapshot = sanitizeReplayEvents([fullSnapshot], state)[0]!;
    const sanitizedMutation = sanitizeReplayEvents([textMutation], state)[0]!;
    const root = (sanitizedSnapshot.data as { node: Record<string, unknown> }).node;
    const children = root["childNodes"] as Array<Record<string, unknown>>;
    const styleChildren = children[0]?.["childNodes"] as Array<Record<string, unknown>>;
    const scriptChildren = children[1]?.["childNodes"] as Array<Record<string, unknown>>;
    const mutationData = sanitizedMutation.data as { texts: Array<{ value: string }> };

    expect(styleChildren[0]?.["textContent"]).toBe("");
    expect(Object.hasOwn(styleChildren[0] ?? {}, "tagName")).toBe(false);
    expect(scriptChildren[0]?.["textContent"]).toBe("");
    expect(Object.hasOwn(scriptChildren[0] ?? {}, "tagName")).toBe(false);
    expect(mutationData.texts[0]?.value).toBe("body{background:url(data:,)}");
    expect(mutationData.texts[1]?.value).toBe("");
  });
});
