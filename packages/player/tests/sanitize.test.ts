import { describe, expect, it } from "vite-plus/test";
import { createReplaySanitizerState, sanitizeReplayEvents } from "../src/sanitize.ts";
import type { ReplayEvent } from "../src/types.ts";

describe("replay event sanitizer", () => {
  it("removes recorded resource URLs before rrweb renders them", () => {
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

    expect(rootAttributes["style"]).toBe("");
    expect(imageAttributes["alt"]).toBe("Logo");
    expect(imageAttributes["rr_src"]).toBe("");
    expect(imageAttributes["rr_dataURL"]).toBe("");
    expect(imageAttributes["src"]).toBe("");
    expect(imageAttributes["srcset"]).toBe("");
    expect(linkAttributes["href"]).toBe("");
    expect(styleChildren[0]?.["textContent"]).toBe("");

    const originalRoot = (event.data as { node: Record<string, unknown> }).node;
    const originalChildren = originalRoot["childNodes"] as Array<Record<string, unknown>>;
    const originalImageAttributes = originalChildren[0]?.["attributes"] as Record<string, string>;
    expect(originalImageAttributes["src"]).toBe("http://169.254.169.254/latest/meta-data");
  });

  it("removes URLs from recorded stylesheet mutation events", () => {
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

    expect(data.adds[0]?.rule).toBe("");
    expect(data.replace).toBe("");
    expect(data.replaceSync).toBe("");
    expect(data.set.value).toBe("");
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

    expect(data.adds[0]?.rule).toBe("");
    expect(data.replaceSync).toBe("");
    expect(data.set.value).toBe("");
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
    expect(data.set.value).toBe("");
    expect(data.set.priority).toBe("");
  });

  it("removes recorded text mutations inside style nodes", () => {
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

  it("removes added text nodes under recorded style nodes", () => {
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

    expect(mutationData.adds[0]?.node.textContent).toBe("");
  });

  it("removes style and script text even when text nodes spoof a tag name", () => {
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
    expect(mutationData.texts[0]?.value).toBe("");
    expect(mutationData.texts[1]?.value).toBe("");
  });

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

  it("removes SVG presentation attributes that can load URLs", () => {
    const event = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          tagName: "svg",
          attributes: {},
          childNodes: [
            {
              type: 2,
              tagName: "rect",
              attributes: {
                "clip-path": "url(#clip)",
                fill: "url(http://127.0.0.1/fill.svg#paint)",
                filter: "url(https://internal.example/filter.svg#blur)",
                mask: "url(https://internal.example/mask.svg#mask)",
                stroke: "red",
                width: "100",
              },
            },
          ],
        },
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const root = (sanitized.data as { node: Record<string, unknown> }).node;
    const children = root["childNodes"] as Array<Record<string, unknown>>;
    const attributes = children[0]?.["attributes"] as Record<string, string>;

    expect(attributes["clip-path"]).toBe("");
    expect(attributes["fill"]).toBe("");
    expect(attributes["filter"]).toBe("");
    expect(attributes["mask"]).toBe("");
    expect(attributes["stroke"]).toBe("");
    expect(attributes["width"]).toBe("100");
  });

  it("disables SVG animation attributes that can reintroduce URLs", () => {
    const event = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          tagName: "svg",
          attributes: {},
          childNodes: [
            {
              type: 2,
              tagName: "animate",
              attributes: {
                attributeName: "href",
                from: "#safe",
                to: "http://127.0.0.1/private.svg",
                values: "#safe;https://internal.example/next.svg",
              },
            },
            {
              type: 2,
              tagName: "set",
              attributes: {
                ATTRIBUTENAME: "filter",
                to: "url(https://internal.example/filter.svg#blur)",
              },
            },
          ],
        },
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const root = (sanitized.data as { node: Record<string, unknown> }).node;
    const children = root["childNodes"] as Array<Record<string, unknown>>;
    const animateAttributes = children[0]?.["attributes"] as Record<string, string>;
    const setAttributes = children[1]?.["attributes"] as Record<string, string>;

    expect(animateAttributes["attributeName"]).toBe("");
    expect(animateAttributes["from"]).toBe("");
    expect(animateAttributes["to"]).toBe("");
    expect(animateAttributes["values"]).toBe("");
    expect(setAttributes["ATTRIBUTENAME"]).toBe("");
    expect(setAttributes["to"]).toBe("");
  });

  it("removes browser-load URLs outside attribute records", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 0,
        adds: [
          {
            node: {
              type: 2,
              tagName: "canvas",
              src: "http://127.0.0.1/private.png",
              dataURL: "data:image/png;base64,private",
            },
          },
        ],
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const data = sanitized.data as {
      adds: Array<{ node: { src: string; dataURL: string } }>;
    };

    expect(data.adds[0]?.node.src).toBe("");
    expect(data.adds[0]?.node.dataURL).toBe("");
  });

  it("drops unsupported canvas mutation events before replay", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 9,
        commands: [
          {
            property: "drawImage",
            args: [{ rr_type: "HTMLImageElement", src: "http://127.0.0.1/private.png" }],
          },
        ],
      },
    } as unknown as ReplayEvent;

    expect(sanitizeReplayEvents([event])).toEqual([]);
  });

  it("removes object-valued recorded style mutations", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 0,
        attributes: [
          {
            id: 1,
            attributes: {
              style: {
                backgroundImage: "url(http://127.0.0.1/private.png)",
                color: "red",
                border: ["1px solid red", "important"],
              },
            },
          },
        ],
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const data = sanitized.data as {
      attributes: Array<{ attributes: { style: Record<string, unknown> } }>;
    };
    const style = data.attributes[0]?.attributes.style;

    expect(style?.["backgroundImage"]).toBe("");
    expect(style?.["color"]).toBe("");
    expect(style?.["border"]).toEqual(["", ""]);
  });

  it("removes recorded font sources before replay", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 10,
        family: "Internal",
        fontSource: "url(https://internal.example/font.woff2)",
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const data = sanitized.data as { family: string; fontSource: string };

    expect(data.family).toBe("Internal");
    expect(data.fontSource).toBe("");
  });

  it("removes other recorded browser-load attributes", () => {
    const event = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          tagName: "div",
          attributes: {},
          childNodes: [
            {
              type: 2,
              tagName: "object",
              attributes: {
                data: "http://127.0.0.1/private.svg",
                onload: "fetch('/private')",
              },
            },
            {
              type: 2,
              tagName: "link",
              attributes: {
                imagesrcset: "https://internal.example/a.png 1x",
              },
            },
            {
              type: 2,
              tagName: "meta",
              attributes: {
                "HTTP-EQUIV": " refresh\t",
                content: "0; url=https://internal.example/next",
              },
            },
            {
              type: 2,
              tagName: "meta",
              attributes: {
                "http-equiv": ["refresh"],
                content: "0; url=https://internal.example/again",
              },
            },
          ],
        },
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const root = (sanitized.data as { node: Record<string, unknown> }).node;
    const children = root["childNodes"] as Array<Record<string, unknown>>;
    const objectAttributes = children[0]?.["attributes"] as Record<string, string>;
    const linkAttributes = children[1]?.["attributes"] as Record<string, string>;
    const metaAttributes = children[2]?.["attributes"] as Record<string, string>;
    const arrayMetaAttributes = children[3]?.["attributes"] as Record<string, string>;

    expect(objectAttributes["data"]).toBe("");
    expect(objectAttributes["onload"]).toBe("");
    expect(linkAttributes["imagesrcset"]).toBe("");
    expect(metaAttributes["HTTP-EQUIV"]).toBe(" refresh\t");
    expect(metaAttributes["content"]).toBe("");
    expect(arrayMetaAttributes["content"]).toBe("");
  });

  it("keeps meta content blank across split attribute mutations", () => {
    const fullSnapshot = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: "meta",
          attributes: {},
          childNodes: [],
        },
      },
    } as unknown as ReplayEvent;
    const contentMutation = {
      type: 3,
      timestamp: 1_001,
      data: {
        source: 0,
        attributes: [
          {
            id: 1,
            attributes: {
              content: "0; url=https://internal.example/next",
            },
          },
        ],
      },
    } as unknown as ReplayEvent;
    const refreshMutation = {
      type: 3,
      timestamp: 1_002,
      data: {
        source: 0,
        attributes: [
          {
            id: 1,
            attributes: {
              "http-equiv": "refresh",
            },
          },
        ],
      },
    } as unknown as ReplayEvent;

    const state = createReplaySanitizerState();
    sanitizeReplayEvents([fullSnapshot], state);
    const sanitizedContent = sanitizeReplayEvents([contentMutation], state);
    const sanitizedRefresh = sanitizeReplayEvents([refreshMutation], state);
    const contentAttributes = (
      sanitizedContent[0]!.data as {
        attributes: Array<{ attributes: { content: string } }>;
      }
    ).attributes[0]?.attributes;
    const refreshAttributes = (
      sanitizedRefresh[0]!.data as {
        attributes: Array<{ attributes: { "http-equiv": string } }>;
      }
    ).attributes[0]?.attributes;

    expect(contentAttributes?.content).toBe("");
    expect(refreshAttributes?.["http-equiv"]).toBe("refresh");
  });

  it("keeps SVG animation mutation attributes blank across events", () => {
    const fullSnapshot = {
      type: 2,
      timestamp: 1_000,
      data: {
        node: {
          type: 2,
          id: 1,
          tagName: "animate",
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
        attributes: [
          {
            id: 1,
            attributes: {
              attributeName: "href",
              to: "https://internal.example/next.svg",
              values: "#safe;https://internal.example/again.svg",
            },
          },
        ],
      },
    } as unknown as ReplayEvent;

    const state = createReplaySanitizerState();
    sanitizeReplayEvents([fullSnapshot], state);
    const sanitized = sanitizeReplayEvents([mutation], state);
    const attributes = (
      sanitized[0]!.data as {
        attributes: Array<{ attributes: Record<string, string> }>;
      }
    ).attributes[0]?.attributes;

    expect(attributes?.["attributeName"]).toBe("");
    expect(attributes?.["to"]).toBe("");
    expect(attributes?.["values"]).toBe("");
  });

  it("keeps recorded prototype keys inert while sanitizing", () => {
    const event = JSON.parse(
      '{"type":2,"timestamp":1000,"data":{"node":{"type":2,"tagName":"img","attributes":{"__proto__":{"polluted":true},"src":"https://internal.example/a.png"}}}}',
    ) as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const root = (sanitized.data as { node: Record<string, unknown> }).node;
    const attributes = root["attributes"] as Record<string, unknown>;

    expect(Object.getPrototypeOf(sanitized)).toBeNull();
    expect(Object.getPrototypeOf(root)).toBeNull();
    expect(Object.getPrototypeOf(attributes)).toBeNull();
    expect(attributes["src"]).toBe("");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
