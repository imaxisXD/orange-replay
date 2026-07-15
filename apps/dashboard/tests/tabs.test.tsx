// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { TabItem, Tabs, TabsList } from "../src/components/ui/tabs";
import type { IconComponent } from "../src/lib/icon-map";
import { SurfaceProvider } from "../src/lib/surface-context";

const TestIcon: IconComponent = (props) => <svg data-testid="tab-icon" {...props} />;

describe("dashboard tabs", () => {
  it("renders an optional leading icon with its visible label", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() =>
      root.render(
        <Tabs value="countries">
          <TabsList>
            <TabItem icon={TestIcon} label="Countries" value="countries" />
          </TabsList>
        </Tabs>,
      ),
    );

    const icon = container.querySelector<SVGElement>('[data-testid="tab-icon"]');
    const tab = container.querySelector<HTMLElement>('[role="tab"]');
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(tab?.textContent).toBe("Countries");

    root.unmount();
  });

  it("uses a requested surface level for the selected tab", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() =>
      root.render(
        <Tabs value="countries">
          <TabsList surfaceLevel={7}>
            <TabItem label="Countries" value="countries" />
            <TabItem label="Regions" value="regions" />
          </TabsList>
        </Tabs>,
      ),
    );

    const selectedSurface = container.querySelector<HTMLElement>('[role="presentation"]');
    expect(selectedSurface?.className).toContain("bg-surface-7");
    expect(selectedSurface?.className).toContain("shadow-surface-7");

    root.unmount();
  });

  it("raises the selected tab above its current surface", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() =>
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

    const selectedSurface = container.querySelector<HTMLElement>('[role="presentation"]');
    expect(selectedSurface?.className).toContain("bg-surface-5");
    expect(selectedSurface?.className).toContain("shadow-surface-5");

    root.unmount();
  });
});
