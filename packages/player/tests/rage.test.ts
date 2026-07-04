import { describe, expect, it } from "vite-plus/test";
import { detectRageClickBursts } from "../src/rage.ts";

describe("rage click detection", () => {
  it("detects three clicks inside 600ms and 24px", () => {
    const bursts = detectRageClickBursts([
      { timeMs: 0, x: 100, y: 100 },
      { timeMs: 250, x: 108, y: 99 },
      { timeMs: 580, x: 96, y: 104 },
    ]);

    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.clickCount).toBe(3);
    expect(bursts[0]?.timeMs).toBe(580);
  });

  it("ignores clicks that are too far apart in time or distance", () => {
    expect(
      detectRageClickBursts([
        { timeMs: 0, x: 100, y: 100 },
        { timeMs: 100, x: 200, y: 200 },
        { timeMs: 200, x: 101, y: 102 },
      ]),
    ).toHaveLength(0);

    expect(
      detectRageClickBursts([
        { timeMs: 0, x: 100, y: 100 },
        { timeMs: 500, x: 101, y: 102 },
        { timeMs: 700, x: 99, y: 103 },
      ]),
    ).toHaveLength(0);
  });
});
