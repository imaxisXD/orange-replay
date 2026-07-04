import { describe, expect, it } from "vite-plus/test";
import { EventType, IncrementalSource, type eventWithTime } from "rrweb";
import { fitReplayToStage, mapReplayPointToStage, replayViewportAt } from "../src/geometry.ts";

describe("replay geometry", () => {
  it("scales and centers a wide recording inside a smaller stage", () => {
    const fit = fitReplayToStage({ width: 1100, height: 700 }, { width: 1600, height: 1000 });

    expect(fit.scale).toBeCloseTo(0.6875);
    expect(fit.width).toBeCloseTo(1100);
    expect(fit.height).toBeCloseTo(687.5);
    expect(fit.left).toBeCloseTo(0);
    expect(fit.top).toBeCloseTo(6.25);
  });

  it("uses scale one when the stage and recording match", () => {
    const fit = fitReplayToStage({ width: 1280, height: 720 }, { width: 1280, height: 720 });

    expect(fit.scale).toBe(1);
    expect(fit.left).toBe(0);
    expect(fit.top).toBe(0);
  });

  it("keeps a tiny stage proportional", () => {
    const fit = fitReplayToStage({ width: 320, height: 180 }, { width: 1600, height: 1000 });

    expect(fit.scale).toBeCloseTo(0.18);
    expect(fit.width).toBeCloseTo(288);
    expect(fit.height).toBeCloseTo(180);
    expect(fit.left).toBeCloseTo(16);
    expect(fit.top).toBeCloseTo(0);
  });

  it("maps overlay points through the same scale and center offset", () => {
    const fit = fitReplayToStage({ width: 1100, height: 700 }, { width: 1600, height: 1000 });

    expect(mapReplayPointToStage({ x: 400, y: 250 }, fit)).toEqual({
      x: 275,
      y: 178.125,
    });
  });

  it("uses the latest viewport event at the current replay time", () => {
    const events: eventWithTime[] = [
      {
        type: EventType.Meta,
        timestamp: 1_000,
        data: { href: "https://example.com", width: 1600, height: 1000 },
      },
      {
        type: EventType.IncrementalSnapshot,
        timestamp: 2_000,
        data: { source: IncrementalSource.ViewportResize, width: 1200, height: 800 },
      },
      {
        type: EventType.Meta,
        timestamp: 3_000,
        data: { href: "https://example.com/next", width: 1440, height: 900 },
      },
    ] as eventWithTime[];

    expect(replayViewportAt(events, 1_500)).toEqual({ width: 1600, height: 1000 });
    expect(replayViewportAt(events, 2_500)).toEqual({ width: 1200, height: 800 });
    expect(replayViewportAt(events, 3_500)).toEqual({ width: 1440, height: 900 });
  });
});
