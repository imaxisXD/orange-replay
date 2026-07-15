// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TabItem, Tabs, TabsList } from "../src/components/ui/tabs";
import type { IconComponent } from "../src/lib/icon-map";
import { SurfaceProvider } from "../src/lib/surface-context";

const TestIcon: IconComponent = (props) => <svg data-testid="tab-icon" {...props} />;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

async function settleTabMeasurements() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("dashboard tabs", () => {
  it("renders an optional leading icon with its visible label", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <Tabs value="countries">
          <TabsList>
            <TabItem icon={TestIcon} label="Countries" value="countries" />
          </TabsList>
        </Tabs>,
      ),
    );
    await settleTabMeasurements();

    const icon = container.querySelector<SVGElement>('[data-testid="tab-icon"]');
    const tab = container.querySelector<HTMLElement>('[role="tab"]');
    const visibleLabel = tab?.querySelector<HTMLElement>("span > span:not([aria-hidden])");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(visibleLabel?.textContent).toBe("Countries");

    await act(async () => root.unmount());
  });

  it("uses a requested surface level for the selected tab", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <Tabs value="countries">
          <TabsList surfaceLevel={7}>
            <TabItem label="Countries" value="countries" />
            <TabItem label="Regions" value="regions" />
          </TabsList>
        </Tabs>,
      ),
    );
    await settleTabMeasurements();

    const selectedSurface = container.querySelector<HTMLElement>(".bg-surface-7");
    expect(selectedSurface?.className).toContain("bg-surface-7");
    expect(selectedSurface?.className).toContain("shadow-surface-7");

    await act(async () => root.unmount());
  });

  it("raises the selected tab above its current surface", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <SurfaceProvider value={2}>
          <Tabs value="countries">
            <TabsList>
              <TabItem label="Countries" value="countries" />
              <TabItem label="Regions" value="regions" />
            </TabsList>
          </Tabs>
        </SurfaceProvider>,
      ),
    );
    await settleTabMeasurements();

    const selectedSurface = container.querySelector<HTMLElement>(".bg-surface-5");
    expect(selectedSurface?.className).toContain("bg-surface-5");
    expect(selectedSurface?.className).toContain("shadow-surface-5");

    await act(async () => root.unmount());
  });

  it("maps index-based selection to tab values", async () => {
    const onSelect = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <Tabs onSelect={onSelect} selectedIndex={1}>
          <TabsList>
            <TabItem label="Countries" value="countries" />
            <TabItem label="Regions" value="regions" />
          </TabsList>
        </Tabs>,
      ),
    );
    await settleTabMeasurements();

    const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(tabs.item(1).getAttribute("aria-selected")).toBe("true");

    await act(async () => tabs.item(0).click());
    expect(onSelect).toHaveBeenCalledWith(0);

    await act(async () => root.unmount());
  });
});
