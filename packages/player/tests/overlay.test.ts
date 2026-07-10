// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ReplayOverlay, shouldRunRageDetectionForClicks } from "../src/overlay.ts";

interface OverlayState {
  cursor: Array<{ timeMs: number; x: number; y: number }>;
  clicks: Array<{ timeMs: number; x: number; y: number }>;
  rageBursts: Array<{ timeMs: number; x: number; y: number }>;
  deadClickTimes: number[];
}

describe("replay overlay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("draws the cursor trail, click ripple, and rage rings", () => {
    let currentLineWidth = 1;
    const strokeWidths: number[] = [];
    const drawing = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      stroke: vi.fn(() => strokeWidths.push(currentLineWidth)),
      globalAlpha: 1,
      lineCap: "butt",
      lineJoin: "miter",
      get lineWidth() {
        return currentLineWidth;
      },
      set lineWidth(value: number) {
        currentLineWidth = value;
      },
      strokeStyle: "",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      drawing as unknown as CanvasRenderingContext2D,
    );

    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { configurable: true, value: 640 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 360 });
    document.body.append(container);

    const overlay = new ReplayOverlay(container);
    const state = overlay as unknown as OverlayState;
    state.cursor = [
      { timeMs: 400, x: 10, y: 10 },
      { timeMs: 700, x: 30, y: 40 },
    ];
    state.clicks = [{ timeMs: 750, x: 30, y: 40 }];
    state.rageBursts = [{ timeMs: 800, x: 30, y: 40 }];
    state.deadClickTimes = [750];

    overlay.draw(900);

    expect(drawing.moveTo).toHaveBeenCalledWith(10, 10);
    expect(drawing.lineTo).toHaveBeenCalledWith(30, 40);
    expect(drawing.arc).toHaveBeenCalledTimes(5);
    expect(strokeWidths.slice(0, 2)).toEqual([8, 4]);
    expect(strokeWidths.at(-1)).toBe(2.5);
    expect(drawing.stroke).toHaveBeenCalledTimes(8);

    state.cursor = [{ timeMs: 800, x: 30, y: 40 }];
    state.clicks = [];
    state.rageBursts = [];
    state.deadClickTimes = [];
    strokeWidths.length = 0;
    drawing.arc.mockClear();
    drawing.stroke.mockClear();

    overlay.draw(900);

    expect(strokeWidths).toEqual([6, 3]);
    expect(drawing.arc).toHaveBeenCalledWith(30, 40, 8, 0, Math.PI * 2);
    expect(drawing.stroke).toHaveBeenCalledTimes(2);

    overlay.destroy();
    container.remove();
  });

  it("bounds dense overlay effects per frame", () => {
    const drawing = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      stroke: vi.fn(),
      globalAlpha: 1,
      lineCap: "butt",
      lineJoin: "miter",
      lineWidth: 1,
      strokeStyle: "",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      drawing as unknown as CanvasRenderingContext2D,
    );

    const container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { configurable: true, value: 640 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 360 });
    document.body.append(container);

    const overlay = new ReplayOverlay(container);
    const state = overlay as unknown as OverlayState;
    state.cursor = Array.from({ length: 20_000 }, (_, index) => ({
      timeMs: 1_000,
      x: index,
      y: index,
    }));
    state.clicks = Array.from({ length: 10_000 }, (_, index) => ({
      timeMs: 1_000,
      x: index,
      y: index,
    }));
    state.rageBursts = Array.from({ length: 5_000 }, (_, index) => ({
      timeMs: 1_000,
      x: index,
      y: index,
    }));
    state.deadClickTimes = Array.from({ length: 10_000 }, () => 1_000);

    overlay.draw(1_100);

    expect(drawing.stroke).toHaveBeenCalledTimes(463);

    overlay.destroy();
    container.remove();
  });
});
