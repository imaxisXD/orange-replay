// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { Switch, type SwitchSize } from "../src/components/ui/switch";

describe("switch sizes", () => {
  it.each([
    ["small", 27.2, 16, 12],
    ["medium", 34, 20, 16],
    ["large", 40.8, 24, 19.2],
  ] as const)(
    "uses the expected %s track and thumb dimensions",
    (size, trackWidth, trackHeight, thumbSize) => {
      const { container, root } = renderSwitch(size);
      const track = findTrack(container);
      const thumb = findThumb(track);

      expect(Number.parseFloat(track.style.width)).toBeCloseTo(trackWidth);
      expect(Number.parseFloat(track.style.height)).toBeCloseTo(trackHeight);
      expect(Number.parseFloat(thumb.style.width)).toBeCloseTo(thumbSize);
      expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(thumbSize);
      expect(trackWidth / trackHeight).toBeCloseTo(34 / 20);

      const innerPadding = (trackHeight - thumbSize) / 2;
      const trackRadius = Number.parseFloat(track.style.borderRadius);
      const thumbRadius = Number.parseFloat(thumb.style.borderRadius);

      expect(trackRadius).toBeCloseTo(trackHeight / 2);
      expect(thumbRadius).toBeCloseTo(thumbSize / 2);
      expect(trackRadius).toBeCloseTo(thumbRadius + innerPadding);

      root.unmount();
    },
  );

  it("keeps medium as the default size", () => {
    const { container, root } = renderSwitch();
    const track = findTrack(container);

    expect(track.dataset.size).toBe("medium");
    expect(track.style.width).toBe("34px");
    expect(track.style.height).toBe("20px");

    root.unmount();
  });

  it("keeps the thumb inset clear of the track border on every edge", () => {
    const { container, root } = renderSwitch("small");
    const thumb = findThumb(findTrack(container));

    expect(thumb.classList.contains("-top-px")).toBe(true);
    expect(thumb.classList.contains("-left-px")).toBe(true);

    root.unmount();
  });

  it("uses a subtle pill shape while holding the small switch", () => {
    const { container, root } = renderSwitch("small");
    const wrapper = container.firstElementChild as HTMLElement;
    const thumb = findThumb(findTrack(container));
    wrapper.setPointerCapture = vi.fn();

    flushSync(() => {
      wrapper.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    });

    expect(Number.parseFloat(thumb.style.width)).toBeCloseTo(13.6);
    expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(10.4);
    expect(Number.parseFloat(thumb.style.borderRadius)).toBeCloseTo(5.2);

    root.unmount();
  });

  it("uses the selected white-bottom to gray-top thumb gradient", () => {
    const { container, root } = renderSwitch("small");
    const thumb = findThumb(findTrack(container));

    expect(thumb.style.backgroundImage).toContain("linear-gradient(to top");
    expect(thumb.style.backgroundImage).toContain("oklch(0.84");
    expect(thumb.style.boxShadow).toContain("inset 0 1px 2px");

    root.unmount();
  });
});

function renderSwitch(size?: SwitchSize) {
  const container = document.createElement("div");
  const root = createRoot(container);

  flushSync(() =>
    root.render(<Switch checked={false} label="Example" onToggle={vi.fn()} size={size} />),
  );

  return { container, root };
}

function findTrack(container: HTMLElement): HTMLElement {
  const track = container.querySelector<HTMLElement>('[role="switch"]');
  if (track === null) throw new Error("Could not find the switch track.");
  return track;
}

function findThumb(track: HTMLElement): HTMLElement {
  const thumb = track.querySelector<HTMLElement>("span");
  if (thumb === null) throw new Error("Could not find the switch thumb.");
  return thumb;
}
