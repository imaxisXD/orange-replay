// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { Button } from "../src/components/ui/button";
import { LoadingIndicator } from "../src/components/ui/loading-indicator";

describe("dashboard loading indicator", () => {
  it("keeps the chosen gradient settings in one shared component", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<LoadingIndicator label="Loading sessions" />));

    const indicator = container.querySelector<HTMLElement>("[data-slot='loading-indicator']");
    expect(indicator?.getAttribute("role")).toBe("status");
    expect(indicator?.getAttribute("aria-label")).toBe("Loading sessions");
    expect(indicator?.getAttribute("data-gspin-reduced-motion")).toBe("respect");
    expect(indicator?.style.gridTemplateColumns).toBe("repeat(5, 4px)");
    expect(indicator?.style.gridAutoRows).toBe("4px");
    expect(indicator?.style.gap).toBe("2px");
    expect(indicator?.style.getPropertyValue("--gspin-period")).toBe("750ms");
    expect(indicator?.style.getPropertyValue("--gspin-dim")).toBe("0.07");
    const cells = indicator?.querySelectorAll<HTMLElement>(".gradient-spin-cell");
    expect(cells).toHaveLength(15);
    expect(cells?.item(0).style.backgroundColor).toBe("rgb(182, 211, 239)");
    expect(cells?.item(0).style.getPropertyValue("--gspin-phase")).toBe("0.5");

    root.unmount();
  });

  it("uses the same indicator when a button is working", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<Button loading>Save changes</Button>));

    const button = container.querySelector("button");
    const indicator = container.querySelector("[data-slot='loading-indicator']");
    expect(button?.disabled).toBe(true);
    expect(indicator?.getAttribute("aria-label")).toBe("Save changes in progress");
    expect(indicator?.querySelectorAll(".gradient-spin-cell")).toHaveLength(15);

    root.unmount();
  });
});
