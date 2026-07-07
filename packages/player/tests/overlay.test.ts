// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import { ReplayOverlay, shouldRunRageDetectionForClicks } from "../src/overlay.ts";

interface OverlayState {
  cursor: Array<{ timeMs: number; x: number; y: number }>;
  clicks: Array<{ timeMs: number; x: number; y: number }>;
  rageBursts: Array<{ timeMs: number; x: number; y: number }>;
}

describe("replay overlay", () => {
  it("skips rage detection when one time window has too many clicks", () => {
    const clicks = Array.from({ length: 501 }, (_, index) => ({
      timeMs: 1_000,
      x: index,
      y: index,
    }));

    expect(shouldRunRageDetectionForClicks(clicks)).toBe(false);
  });

  it("allows normal click windows through rage detection", () => {
    const clicks = Array.from({ length: 100 }, (_, index) => ({
      timeMs: index * 700,
      x: index,
      y: index,
    }));

    expect(shouldRunRageDetectionForClicks(clicks)).toBe(true);
  });

  it("keeps recorded overlay events when playback seeks backward", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { configurable: true, value: 640 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 360 });
    document.body.append(container);

    const overlay = new ReplayOverlay(container);
    const state = overlay as unknown as OverlayState;
    state.cursor = [
      { timeMs: 1_000, x: 10, y: 10 },
      { timeMs: 10_000, x: 20, y: 20 },
    ];
    state.clicks = [
      { timeMs: 1_100, x: 11, y: 11 },
      { timeMs: 10_100, x: 21, y: 21 },
    ];
    state.rageBursts = [
      { timeMs: 1_200, x: 12, y: 12 },
      { timeMs: 10_200, x: 22, y: 22 },
    ];

    overlay.draw(10_500);
    overlay.draw(1_200);

    expect(state.cursor.map((point) => point.timeMs)).toEqual([1_000, 10_000]);
    expect(state.clicks.map((point) => point.timeMs)).toEqual([1_100, 10_100]);
    expect(state.rageBursts.map((point) => point.timeMs)).toEqual([1_200, 10_200]);

    overlay.destroy();
    container.remove();
  });
});
