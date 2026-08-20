// @vitest-environment happy-dom
import { createRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ReplayControls } from "../src/routes/session-detail/replay-playback/replay-controls";
import { ReplayStage } from "../src/routes/session-detail/replay-playback/replay-stage";
import type { ReplayPlayerState } from "../src/routes/session-detail/use-replay-player";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("replay mobile layout", () => {
  it("keeps the stage inside the card width instead of a fixed desktop height", async () => {
    await act(async () => {
      root.render(
        <ReplayStage
          buffering={false}
          containerRef={createRef<HTMLDivElement>()}
          isFollowing={false}
          liveConnected={false}
          playerError={null}
          ready
          retryPlayer={vi.fn()}
          waitingForKeyframe={false}
        />,
      );
    });

    const stage = container.querySelector("[data-testid='replay-stage']");
    expect(stage?.className).toContain("w-full");
    expect(stage?.className).toContain("min-w-0");
    expect(stage?.className).toContain("overflow-hidden");
    expect(stage?.className).toContain("min-h-48");
    expect(stage?.className).toContain("sm:min-h-90");
    expect(stage?.className).toContain("aspect-video");
  });

  it("wraps playback controls instead of forcing a horizontal scrollbar", async () => {
    await act(async () => {
      root.render(
        <ReplayControls
          activityBuckets={[]}
          deadClickMarkers={[]}
          errorMarkers={[]}
          firstErrorSeekMs={null}
          player={stubPlayer()}
          rageMarkers={[]}
        />,
      );
    });

    const controls = container.querySelector("[data-testid='replay-controls']");
    expect(controls?.className).toContain("flex-wrap");
    expect(controls?.className).toContain("min-w-0");
    expect(controls?.className).toContain("w-full");
    expect(controls?.className).not.toContain("w-max");
    expect(container.querySelector("[data-slot='scroll-area']")).toBeNull();
    expect(container.querySelector('[aria-label="Replay timeline"]')?.className).toContain(
      "min-w-0",
    );
  });
});

function stubPlayer(): ReplayPlayerState {
  return {
    containerRef: createRef<HTMLDivElement>(),
    timelineRef: createRef<HTMLDivElement>(),
    state: {
      buffering: false,
      currentMs: 0,
      deadClicks: [],
      flashKey: 0,
      liveState: { connected: false },
      playerError: null,
      playing: false,
      ready: true,
      skipIdle: false,
      speed: 1,
      waitingForKeyframe: false,
    },
    values: {
      isFollowing: false,
      playheadPercent: 0,
      timelineDurationMs: 8_000,
    },
    actions: {
      cycleSpeed: vi.fn(),
      seekAndPlay: vi.fn(),
      retryPlayer: vi.fn(),
      seekFromPointer: vi.fn(),
      seekTo: vi.fn(),
      stopTimelineDrag: vi.fn(),
      startTimelineDrag: vi.fn(),
      moveTimelineDrag: vi.fn(),
      togglePlayback: vi.fn(),
      toggleSkipIdle: vi.fn(),
    },
  } as ReplayPlayerState;
}
