import { describe, expect, it } from "vite-plus/test";
import {
  DEMO_BANNER_ANIMATION_DEFAULTS,
  DEMO_EDGE_VECTOR_EFFECT,
  createSplitEdgePaths,
} from "../src/routes/demo-banner-animation";

describe("demo banner animation defaults", () => {
  it("keeps the promoted demo sequence aligned with the tuned DialKit values", () => {
    expect(DEMO_BANNER_ANIMATION_DEFAULTS).toEqual({
      timing: {
        workspaceEnter: 50,
        edgeDraw: 500,
        notchDelay: 10,
      },
      entry: {
        offsetY: 0,
        startScale: 0.94,
        startOpacity: 0,
        spring: { type: "spring", visualDuration: 0.95, bounce: 0.2 },
      },
      edge: {
        strokeWidth: 0.7,
        opacity: 0.92,
        glowBlur: 23,
        glowOpacity: 1,
        spring: { type: "spring", visualDuration: 0.6, bounce: 0 },
        settle: {
          strokeWidth: 0,
          opacity: 0,
          glowBlur: 23,
          glowOpacity: 0,
          spring: { type: "spring", visualDuration: 0.45, bounce: 0 },
        },
      },
      notch: {
        height: 81,
        visibleHeight: 42,
        widthPercent: 50,
        offsetX: -13,
        cornerRadius: 8,
        slantWidth: 48,
        slantRadius: 7,
        litBorderWidth: 2.8,
        glowBlur: 64,
        glowOpacity: 0,
        dots: { fadePerRow: 0.065, intensity: 4.3, pulse: 2.3 },
        spring: { type: "spring", visualDuration: 0.8, bounce: 0.15 },
      },
    });
  });

  it("closes both paths at the bottom center without breaking normalized dash length", () => {
    expect(DEMO_EDGE_VECTOR_EFFECT).toBe("none");
    expect(createSplitEdgePaths(100, 80)).toEqual([
      "M 50 1 H 12 Q 1 1 1 12 V 68 Q 1 79 12 79 H 50",
      "M 50 1 H 88 Q 99 1 99 12 V 68 Q 99 79 88 79 H 50",
    ]);
  });
});
