import { describe, expect, it } from "vite-plus/test";
import {
  analyticsSidecarByteLength,
  analyticsSidecarLines,
  analyticsSidecarParts,
} from "../src/do/session-analytics-sidecar.ts";

describe("analytics sidecar", () => {
  it("keeps every scrubbed sidecar event in stable order", () => {
    const lines = [
      ...analyticsSidecarLines(
        [
          {
            events: JSON.stringify([
              { t: 10, k: "click", d: "button#buy", m: { x: 0.5, y: 0.25 } },
              { t: 11, k: "error", d: "Checkout failed" },
              { t: 11, k: "rage", d: "untrusted" },
            ]),
          },
          { events: JSON.stringify([{ t: 12, k: "scroll", m: { depth: 80 } }]) },
        ],
        [{ t: 13, k: "rage", d: "3 clicks" }],
      ),
    ].map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toEqual([
      { v: 1, coverage: "complete" },
      {
        event_index: 0,
        event_time: 10,
        event_kind: "click",
        event_detail: "button#buy",
        event_meta: { x: 0.5, y: 0.25 },
      },
      {
        event_index: 1,
        event_time: 11,
        event_kind: "error",
        event_detail: "Checkout failed",
      },
      { event_index: 2, event_time: 12, event_kind: "scroll", event_meta: { depth: 80 } },
      { event_index: 3, event_time: 13, event_kind: "rage", event_detail: "3 clicks" },
    ]);
  });

  it("does not contain replay payload fields", () => {
    const output = [...analyticsSidecarLines([{ events: "[]" }])].join("");
    expect(output).not.toContain("body");
    expect(output).not.toContain("payload");
    expect(output).not.toContain("rrweb");
  });

  it("reports the exact byte length needed by R2", () => {
    const rows = [{ events: JSON.stringify([{ t: 10, k: "click", d: "buy" }]) }];
    const text = [...analyticsSidecarLines(rows)].join("");

    expect(analyticsSidecarByteLength(rows)).toBe(new TextEncoder().encode(text).byteLength);
  });

  it("rejoins small R2 parts without changing a byte", () => {
    const rows = [{ events: JSON.stringify([{ t: 10, k: "click", d: "buy" }]) }];
    const expected = new TextEncoder().encode([...analyticsSidecarLines(rows)].join(""));
    const parts = [...analyticsSidecarParts(rows, [], 7)];
    const joined = new Uint8Array(parts.reduce((bytes, part) => bytes + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      expect(part.byteLength).toBeLessThanOrEqual(7);
      joined.set(part, offset);
      offset += part.byteLength;
    }

    expect(joined).toEqual(expected);
    expect(() => [...analyticsSidecarParts(rows, [], 0)]).toThrow("positive whole number");
  });
});
