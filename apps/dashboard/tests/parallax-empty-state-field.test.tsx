// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ParallaxEmptyStateField } from "../src/components/parallax-empty-state-field";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parallax empty-state field", () => {
  it("renders every surrounding object as a decorative depth layer", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(
        <ParallaxEmptyStateField
          layers={[
            {
              src: "/first.webp",
              left: "10%",
              top: "20%",
              width: "4rem",
              movement: 12,
              opacity: 0.4,
            },
            {
              src: "/second.webp",
              left: "90%",
              top: "70%",
              width: "3rem",
              movement: -8,
              opacity: 0.2,
            },
          ]}
        >
          <p>Empty state copy</p>
        </ParallaxEmptyStateField>,
      );
    });

    const layers = container.querySelectorAll<HTMLImageElement>("[data-parallax-movement]");
    expect(layers).toHaveLength(2);
    expect(Array.from(layers, (layer) => layer.alt)).toEqual(["", ""]);
    expect(container.textContent).toContain("Empty state copy");

    act(() => root.unmount());
  });

  it("smoothly moves mouse layers and starts returning them on pointer leave", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <ParallaxEmptyStateField
          layers={[
            {
              src: "/object.webp",
              left: "10%",
              top: "20%",
              width: "4rem",
              movement: 12,
              opacity: 0.4,
            },
          ]}
        >
          <p>Copy</p>
        </ParallaxEmptyStateField>,
      );
    });

    const field = container.querySelector<HTMLElement>(".parallax-empty-state");
    const layer = container.querySelector<HTMLElement>("[data-parallax-movement]");
    expect(field).not.toBeNull();
    expect(layer).not.toBeNull();
    vi.spyOn(field!, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      top: 0,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      field!.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: 200,
          clientY: 50,
          pointerType: "mouse",
        }),
      );
    });
    expect(field?.dataset.moving).toBe("true");
    expect(frames).toHaveLength(1);

    act(() => {
      frames.shift()?.(0);
      frames.shift()?.(16);
    });
    expect(Number.parseFloat(layer?.style.getPropertyValue("--parallax-x") ?? "0")).toBeGreaterThan(
      0,
    );

    act(() => {
      field!.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
    });
    expect(field?.dataset.moving).toBe("true");

    act(() => root.unmount());
  });
});
