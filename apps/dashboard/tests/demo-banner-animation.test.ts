import { describe, expect, it } from "vite-plus/test";
import { DEMO_EDGE_VECTOR_EFFECT, createSplitEdgePaths } from "../src/routes/demo-banner-animation";

describe("demo banner perimeter", () => {
  it("closes both paths at the bottom center without breaking normalized dash length", () => {
    expect(DEMO_EDGE_VECTOR_EFFECT).toBe("none");
    expect(createSplitEdgePaths(100, 80)).toEqual([
      "M 50 1 H 12 Q 1 1 1 12 V 68 Q 1 79 12 79 H 50",
      "M 50 1 H 88 Q 99 1 99 12 V 68 Q 99 79 88 79 H 50",
    ]);
  });
});
