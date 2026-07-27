// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { Switch, type SwitchSize } from "../src/components/ui/switch";

describe("switch sizes", () => {
  it.each([
    ["small", 27.2, 16, 10],
    ["medium", 34, 20, 14],
    ["large", 40.8, 24, 17.2],
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

      // Corners are absolute rather than derived, so every size reads as the
      // same soft-cornered rectangle instead of scaling into a pill.
      expect(Number.parseFloat(track.style.borderRadius)).toBeCloseTo(2);
      expect(Number.parseFloat(thumb.style.borderRadius)).toBeCloseTo(1);

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

  it("leaves the same gap on every edge of the thumb", () => {
    const { container, root } = renderSwitch();
    const thumb = findThumb(findTrack(container));

    // The thumb sits at -1px and is then translated by the track padding, so
    // the padding is what shows: 3px per side at medium, 1px of it the border.
    expect(thumb.classList.contains("-top-px")).toBe(true);
    expect(thumb.classList.contains("-left-px")).toBe(true);
    expect((20 - Number.parseFloat(thumb.style.height)) / 2).toBeCloseTo(3);

    root.unmount();
  });

  it("keeps the travel distance the shipped pill had", () => {
    const { container, root } = renderSwitch();
    const thumb = findThumb(findTrack(container));
    const thumbSize = Number.parseFloat(thumb.style.height);
    const innerPadding = (20 - thumbSize) / 2;

    expect(34 - thumbSize - innerPadding * 2).toBeCloseTo(14);

    root.unmount();
  });

  it.each([
    ["small", 10],
    ["medium", 14],
    ["large", 17.2],
  ] as const)("holds the %s thumb square while it is pressed", (size, thumbSize) => {
    const { container, root } = renderSwitch(size);
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

    // A press scales the thumb around its center rather than trading height
    // for width, so its box never changes and its corners stay proportional.
    // Squashing one axis is a capsule's idiom; on a square it reads as damage.
    expect(Number.parseFloat(thumb.style.width)).toBeCloseTo(thumbSize);
    expect(Number.parseFloat(thumb.style.height)).toBeCloseTo(thumbSize);

    root.unmount();
  });

  it("gives the thumb a flat white fill with no gradient or bevel", () => {
    const { container, root } = renderSwitch();
    const thumb = findThumb(findTrack(container));

    expect(thumb.style.backgroundImage).toBe("");
    expect(thumb.style.boxShadow).toBe("");
    expect(thumb.classList.contains("bg-white")).toBe(true);

    root.unmount();
  });
});

describe("switch track fill", () => {
  it("holds a dim light gray behind an off switch", () => {
    const { container, root } = renderSwitch();
    const [offFill, accent] = findFills(findTrack(container));

    expect(offFill.style.backgroundColor).toContain("--switch-off-fill");
    expect(Number.parseFloat(offFill.style.opacity)).toBeCloseTo(0.22);
    expect(Number.parseFloat(accent.style.opacity)).toBeCloseTo(0);

    root.unmount();
  });

  it("swaps the gray for the accent once the switch is on", () => {
    const { container, root } = renderSwitch(undefined, true);
    const [offFill, accent] = findFills(findTrack(container));

    expect(accent.style.backgroundColor).toContain("--amber");
    expect(Number.parseFloat(accent.style.opacity)).toBeCloseTo(1);
    expect(Number.parseFloat(offFill.style.opacity)).toBeCloseTo(0);

    root.unmount();
  });

  it("keeps the track base neutral so hover still reads when off", () => {
    const { container, root } = renderSwitch();
    const track = findTrack(container);

    expect(track.style.backgroundColor).toContain("--secondary");
    expect(track.style.borderColor).toContain("--border");

    root.unmount();
  });

  it("hides both fills from assistive tech", () => {
    const { container, root } = renderSwitch();

    for (const fill of findFills(findTrack(container))) {
      expect(fill.getAttribute("aria-hidden")).toBe("true");
    }

    root.unmount();
  });
});

function renderSwitch(size?: SwitchSize, checked = false) {
  const container = document.createElement("div");
  const root = createRoot(container);

  flushSync(() =>
    root.render(<Switch checked={checked} label="Example" onToggle={vi.fn()} size={size} />),
  );

  return { container, root };
}

function findTrack(container: HTMLElement): HTMLElement {
  const track = container.querySelector<HTMLElement>('[role="switch"]');
  if (track === null) throw new Error("Could not find the switch track.");
  return track;
}

/** The two fill layers, off fill first, in the order they stack. */
function findFills(track: HTMLElement): [HTMLElement, HTMLElement] {
  const fills = track.querySelectorAll<HTMLElement>(":scope > span[aria-hidden]");
  if (fills.length !== 2) throw new Error(`Expected 2 fill layers, found ${fills.length}.`);
  return [fills[0] as HTMLElement, fills[1] as HTMLElement];
}

/** The thumb is the last span in the track, after both fill layers. */
function findThumb(track: HTMLElement): HTMLElement {
  const spans = track.querySelectorAll<HTMLElement>(":scope > span");
  const thumb = spans[spans.length - 1];
  if (thumb === undefined) throw new Error("Could not find the switch thumb.");
  return thumb;
}
