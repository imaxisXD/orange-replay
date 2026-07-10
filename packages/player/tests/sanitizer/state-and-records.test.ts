import { describe, expect, it } from "vite-plus/test";
import {
  createReplaySanitizerState,
  sanitizeReplayEvents,
  type ReplayEvent,
} from "./test-helpers.ts";

describe("replay event sanitizer: state and safe records", () => {
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
