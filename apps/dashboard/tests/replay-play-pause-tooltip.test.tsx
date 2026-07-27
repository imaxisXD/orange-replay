// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MotionProvider } from "../src/lib/motion-provider";
import { ShapeProvider } from "../src/lib/shape-context";
import { ReplayPlayPauseControl } from "../src/routes/session-detail/replay-playback/replay-controls";

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

describe("Replay Play/Pause tooltip", () => {
  it("keeps the existing control and uses the standard tooltip", async () => {
    const onToggle = vi.fn();

    await act(async () => {
      root.render(
        <MotionProvider>
          <ShapeProvider defaultShape="rounded">
            <ReplayPlayPauseControl onToggle={onToggle} playing={false} />
          </ShapeProvider>
        </MotionProvider>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>("button");

    expect(trigger?.getAttribute("aria-label")).toBe("Play replay");
    expect(trigger?.className).toContain("size-8");
    expect(trigger?.className).toContain("bg-foreground");
    expect(trigger?.hasAttribute("data-morph-tooltip-trigger")).toBe(false);

    await act(async () => trigger?.click());
    expect(onToggle).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(
        <MotionProvider>
          <ShapeProvider defaultShape="rounded">
            <ReplayPlayPauseControl onToggle={onToggle} playing />
          </ShapeProvider>
        </MotionProvider>,
      );
    });

    expect(trigger?.getAttribute("aria-label")).toBe("Pause replay");

    await act(async () => trigger?.focus());
    expect(document.body.textContent).toContain("Pause replay · Space");
  });
});
