import { describe, expect, it, vi } from "vite-plus/test";
import { sanitizeReplayEvents, type ReplayEvent } from "./test-helpers.ts";

describe("replay event sanitizer: resources", () => {
  it("keeps safe SVG presentation values while removing external URLs", () => {
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

    expect(attributes["clip-path"]).toBe("url(#clip)");
    expect(attributes["fill"]).toBe("url(data:,)");
    expect(attributes["filter"]).toBe("url(data:,)");
    expect(attributes["mask"]).toBe("url(data:,)");
    expect(attributes["stroke"]).toBe("red");
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

  it("keeps safe inline canvas images while removing external sources", () => {
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
    expect(data.adds[0]?.node.dataURL).toBe("data:image/png;base64,private");
  });

  it("keeps only the fixed inline-image canvas frame format", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 9,
        id: 12,
        type: 0,
        commands: [
          { property: "clearRect", args: [0, 0, 640, 360] },
          {
            property: "drawImage",
            args: [
              {
                rr_type: "ImageBitmap",
                args: [
                  {
                    rr_type: "Blob",
                    data: [{ rr_type: "ArrayBuffer", base64: "AQID" }],
                    type: "image/webp",
                  },
                ],
              },
              0,
              0,
              640,
              360,
            ],
          },
        ],
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event]);

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.data).toEqual(event.data);
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

  it("keeps object-valued styles while removing their external URLs", () => {
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

    expect(style?.["backgroundImage"]).toBe("url(data:,)");
    expect(style?.["color"]).toBe("red");
    expect(style?.["border"]).toEqual(["1px solid red", "important"]);
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

  it("keeps captured font bytes that cannot make a network request", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 10,
        family: "Captured",
        buffer: true,
        fontSource: "[0,17,128,255]",
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const data = sanitized.data as { fontSource: string };

    expect(data.fontSource).toBe("[0,17,128,255]");
  });

  it("rejects malformed captured font bytes", () => {
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 10,
        family: "Captured",
        buffer: true,
        fontSource: "[0,256,-1]",
      },
    } as unknown as ReplayEvent;

    const sanitized = sanitizeReplayEvents([event])[0]!;
    const data = sanitized.data as { fontSource: string };

    expect(data.fontSource).toBe("");
  });

  it("rejects oversized captured fonts before parsing nested JSON", () => {
    const parseJson = vi.spyOn(JSON, "parse");
    const event = {
      type: 3,
      timestamp: 1_000,
      data: {
        source: 10,
        family: "Captured",
        buffer: true,
        fontSource: `[${"0".repeat(2_097_153)}]`,
      },
    } as unknown as ReplayEvent;

    try {
      const sanitized = sanitizeReplayEvents([event])[0]!;
      const data = sanitized.data as { fontSource: string };

      expect(data.fontSource).toBe("");
      expect(parseJson).not.toHaveBeenCalled();
    } finally {
      parseJson.mockRestore();
    }
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
});
