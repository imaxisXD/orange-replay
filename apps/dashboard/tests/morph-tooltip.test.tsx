// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  MorphTooltip,
  MORPH_TOOLTIP_DASHBOARD_TIMING,
  MORPH_TOOLTIP_MOTION_PRESETS,
  MORPH_TOOLTIP_SIZE_METRICS,
  type MorphTooltipSize,
} from "../src/components/ui/morph-tooltip";
import { MotionProvider } from "../src/lib/motion-provider";
import { ShapeProvider } from "../src/lib/shape-context";

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

function Providers({ children }: { children: ReactNode }) {
  return (
    <MotionProvider>
      <ShapeProvider defaultShape="rounded">
        <MorphTooltip.Provider delay={0}>{children}</MorphTooltip.Provider>
      </ShapeProvider>
    </MotionProvider>
  );
}

function Example({ open, size }: { open: boolean; size: MorphTooltipSize }) {
  return (
    <Providers>
      <MorphTooltip.Root key={size} open={open} size={size}>
        <MorphTooltip.IconTrigger aria-label={`${size} tooltip`} data-testid="morph-trigger">
          ?
        </MorphTooltip.IconTrigger>
        <MorphTooltip.Portal>
          <MorphTooltip.Positioner collisionAvoidance={{ align: "none", side: "none" }}>
            <MorphTooltip.Popup data-testid="morph-popup">
              <MorphTooltip.Viewport>
                <MorphTooltip.Label>Helpful context</MorphTooltip.Label>
              </MorphTooltip.Viewport>
            </MorphTooltip.Popup>
          </MorphTooltip.Positioner>
        </MorphTooltip.Portal>
      </MorphTooltip.Root>
    </Providers>
  );
}

describe("MorphTooltip", () => {
  it("provides sm, md, and lg surface sizes", async () => {
    for (const size of ["sm", "md", "lg"] as const) {
      await act(async () => root.render(<Example open size={size} />));

      const metrics = MORPH_TOOLTIP_SIZE_METRICS[size];
      const trigger = container.querySelector<HTMLElement>('[data-testid="morph-trigger"]');
      const popup = document.body.querySelector<HTMLElement>(
        `[data-testid="morph-popup"][data-size="${size}"]`,
      );
      const surface = popup?.querySelector<HTMLElement>('[data-morph-tooltip-surface=""]');

      expect(trigger?.dataset.size).toBe(size);
      expect(trigger?.style.width).toBe(`${metrics.closedSize}px`);
      expect(trigger?.style.height).toBe(`${metrics.closedSize}px`);
      expect(popup?.dataset.size).toBe(size);
      expect(popup?.style.width).toBe(`${metrics.openWidth}px`);
      expect(popup?.style.height).toBe(`${metrics.openHeight}px`);
      expect(surface?.style.width).toBe(`${metrics.openWidth}px`);
      expect(surface?.style.height).toBe(`${metrics.openHeight}px`);
    }
  });

  it("forwards Base UI props through each compound part", async () => {
    await act(async () => {
      root.render(
        <Providers>
          <MorphTooltip.Root disableHoverablePopup open size="md" trackCursorAxis="x">
            <MorphTooltip.Trigger
              aria-label="Primitive props"
              className="custom-trigger"
              data-custom-trigger="yes"
              delay={25}
              render={
                <button
                  data-rendered-trigger="yes"
                  style={{ height: 24, width: 132 }}
                  type="button"
                />
              }
            >
              ?
            </MorphTooltip.Trigger>
            <MorphTooltip.Portal container={container}>
              <MorphTooltip.Positioner
                className="custom-positioner"
                data-custom-positioner="yes"
                side="bottom"
                sideOffset={12}
              >
                <MorphTooltip.Popup
                  className="custom-popup"
                  data-custom-popup="yes"
                  landingOffset={12}
                >
                  <MorphTooltip.Arrow
                    data-custom-arrow="yes"
                    render={<div data-rendered-arrow="yes" />}
                  />
                  <MorphTooltip.Viewport className="custom-viewport" data-custom-viewport="yes">
                    <MorphTooltip.Label className="custom-label">
                      Helpful context
                    </MorphTooltip.Label>
                  </MorphTooltip.Viewport>
                </MorphTooltip.Popup>
              </MorphTooltip.Positioner>
            </MorphTooltip.Portal>
          </MorphTooltip.Root>
        </Providers>,
      );
    });

    expect(container.querySelector('[data-custom-trigger="yes"]')).not.toBeNull();
    expect(container.querySelector('[data-rendered-trigger="yes"]')).not.toBeNull();
    expect(container.querySelector(".custom-trigger")).not.toBeNull();
    expect(container.querySelector<HTMLElement>('[data-rendered-trigger="yes"]')?.style.width).toBe(
      "132px",
    );
    expect(
      container.querySelector<HTMLElement>('[data-rendered-trigger="yes"]')?.style.height,
    ).toBe("24px");
    expect(container.querySelector('[data-custom-positioner="yes"]')).not.toBeNull();
    expect(container.querySelector(".custom-positioner")).not.toBeNull();
    expect(container.querySelector('[data-custom-popup="yes"]')).not.toBeNull();
    expect(
      container
        .querySelector('[data-custom-popup="yes"]')
        ?.querySelector('[data-morph-tooltip-surface=""].custom-popup'),
    ).not.toBeNull();
    expect(container.querySelector('[data-custom-arrow="yes"]')).not.toBeNull();
    expect(container.querySelector('[data-rendered-arrow="yes"]')).not.toBeNull();
    expect(container.querySelector('[data-custom-viewport="yes"]')).not.toBeNull();
    expect(container.querySelector(".custom-viewport")).not.toBeNull();
    expect(container.querySelector(".custom-label")).not.toBeNull();
  });

  it("measures a composed rectangular trigger for the closed morph surface", async () => {
    await act(async () => {
      root.render(
        <Providers>
          <MorphTooltip.Root open={false} size="sm">
            <MorphTooltip.Trigger
              aria-label="Rectangular trigger"
              render={<button style={{ height: 24, width: 132 }} type="button" />}
            >
              Copy session ID
            </MorphTooltip.Trigger>
            <MorphTooltip.Portal>
              <MorphTooltip.Positioner collisionAvoidance={{ align: "none", side: "none" }}>
                <MorphTooltip.Popup>
                  <MorphTooltip.Label>Copy session ID</MorphTooltip.Label>
                </MorphTooltip.Popup>
              </MorphTooltip.Positioner>
            </MorphTooltip.Portal>
          </MorphTooltip.Root>
        </Providers>,
      );
    });

    const surface = document.body.querySelector<HTMLElement>('[data-morph-tooltip-surface=""]');
    const content = document.body.querySelector<HTMLElement>('[data-morph-tooltip-content=""]');

    expect(surface?.style.width).toBe("132px");
    expect(surface?.style.height).toBe("24px");
    expect(content?.style.transform).toContain("translate(-6px, -4px)");
  });

  it("defaults to the finalized dashboard timing and keeps the measured reference optional", () => {
    expect(MORPH_TOOLTIP_DASHBOARD_TIMING).toEqual({
      bounce: 0.2,
      holdMs: 500,
      surfaceCloseMs: 120,
      surfaceDelayMs: 200,
      surfaceOpenMs: 200,
      textDelayMs: 150,
      textHideMs: 10,
      textRevealMs: 200,
    });
    expect(MORPH_TOOLTIP_MOTION_PRESETS.dashboard.surfaceOpen).toMatchObject({
      bounce: 0.2,
      delay: 0.2,
      duration: 0.2,
      type: "spring",
    });
    expect(MORPH_TOOLTIP_MOTION_PRESETS.dashboard.surfaceClose).toMatchObject({
      bounce: 0.1,
      duration: 0.12,
      type: "spring",
    });
    expect(MORPH_TOOLTIP_MOTION_PRESETS.dashboard.labelOpen).toMatchObject({
      delay: 0.15,
      duration: 0.2,
      ease: "easeInOut",
    });
    expect(MORPH_TOOLTIP_MOTION_PRESETS.dashboard.labelClose).toMatchObject({
      duration: 0.01,
      ease: "easeInOut",
    });
    expect(MORPH_TOOLTIP_MOTION_PRESETS.dashboard.contentDurationMs).toBe(200);
    expect(MORPH_TOOLTIP_MOTION_PRESETS.reference.surfaceOpen).toMatchObject({
      bounce: 0.2,
      delay: 0.2,
      duration: 0.5,
      type: "spring",
    });
  });

  it("keeps a stable Base UI popup box while Motion projects the closed surface", async () => {
    await act(async () => root.render(<Example open={false} size="md" />));

    const metrics = MORPH_TOOLTIP_SIZE_METRICS.md;
    const positioner = document.body.querySelector<HTMLElement>(
      '[data-morph-tooltip-positioner=""]',
    );
    const popup = document.body.querySelector<HTMLElement>('[data-morph-tooltip-popup=""]');
    const surface = popup?.querySelector<HTMLElement>('[data-morph-tooltip-surface=""]');
    const content = popup?.querySelector<HTMLElement>('[data-morph-tooltip-content=""]');
    const viewport = popup?.querySelector<HTMLElement>('[data-morph-tooltip-viewport=""]');

    expect(positioner?.hasAttribute("hidden")).toBe(false);
    expect(positioner?.getAttribute("aria-hidden")).toBe("true");
    expect(positioner?.style.width).toBe(`${metrics.openWidth}px`);
    expect(positioner?.style.height).toBe(`${metrics.openHeight}px`);
    expect(popup?.style.width).toBe(`${metrics.openWidth}px`);
    expect(popup?.style.height).toBe(`${metrics.openHeight}px`);
    expect(surface?.style.width).toBe(`${metrics.closedSize}px`);
    expect(surface?.style.height).toBe(`${metrics.closedSize}px`);
    expect(surface?.contains(viewport ?? null)).toBe(false);
    expect(content?.contains(viewport ?? null)).toBe(true);
    expect(viewport?.style.minWidth).toBe("0px");
    expect(viewport?.style.maxWidth).toBe("100%");
  });

  it("uses Base UI's transform origin and respects logical sides in RTL", async () => {
    await act(async () => {
      root.render(
        <DirectionProvider direction="rtl">
          <Providers>
            <MorphTooltip.Root open={false} size="md">
              <MorphTooltip.IconTrigger aria-label="RTL tooltip">?</MorphTooltip.IconTrigger>
              <MorphTooltip.Portal>
                <MorphTooltip.Positioner
                  collisionAvoidance={{ align: "none", side: "none" }}
                  side="inline-start"
                >
                  <MorphTooltip.Popup data-testid="rtl-popup">
                    <MorphTooltip.Label>Helpful context</MorphTooltip.Label>
                  </MorphTooltip.Popup>
                </MorphTooltip.Positioner>
              </MorphTooltip.Portal>
            </MorphTooltip.Root>
          </Providers>
        </DirectionProvider>,
      );
    });

    const popup = document.body.querySelector<HTMLElement>('[data-testid="rtl-popup"]');
    expect(popup?.style.transform).toContain("translate(-66px, -6px)");
    expect(popup?.style.transformOrigin).toBe("var(--transform-origin)");
  });

  it("keeps one moving surface mounted through controlled state changes", async () => {
    await act(async () => root.render(<Example open={false} size="md" />));
    const trigger = container.querySelector<HTMLElement>('[data-testid="morph-trigger"]');
    expect(trigger?.hasAttribute("data-surface-visible")).toBe(true);

    await act(async () => root.render(<Example open size="md" />));
    expect(trigger?.hasAttribute("data-surface-visible")).toBe(false);

    await act(async () => root.render(<Example open={false} size="md" />));
    expect(document.body.querySelectorAll('[data-morph-tooltip-popup=""]')).toHaveLength(1);
  });
});
