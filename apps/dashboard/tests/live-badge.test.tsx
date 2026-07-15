// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { LiveBadge, LiveDot } from "../src/components/live-badge";

describe("live badge", () => {
  it("recreates the landing badge with a stable 7 by 7 light field", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<LiveBadge />));

    const badge = container.querySelector("[data-slot='live-badge']");
    const lights = badge?.querySelectorAll<HTMLElement>(".live-dot__light .px");
    expect(badge?.textContent).toBe("Live now");
    expect(lights).toHaveLength(49);
    expect(Number(lights?.item(0).style.getPropertyValue("--base"))).toBeLessThan(0.6);
    expect(Number(lights?.item(24).style.getPropertyValue("--base"))).toBeGreaterThanOrEqual(0.9);
    expect(lights?.item(48).style.getPropertyValue("--dur")).toMatch(/^\d\.\d{2}s$/);

    const firstRenderStyles = Array.from(lights ?? [], (light) => light.getAttribute("style"));
    flushSync(() => root.render(<LiveBadge />));
    const secondRenderStyles = Array.from(
      container.querySelectorAll<HTMLElement>(".live-dot__light .px"),
      (light) => light.getAttribute("style"),
    );
    expect(secondRenderStyles).toEqual(firstRenderStyles);

    root.unmount();
  });

  it("uses the landing page's compact pinlight without hidden pixel cells", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<LiveDot size="sm" />));

    const dot = container.querySelector("[data-slot='live-dot']");
    expect(dot?.classList.contains("live-dot--sm")).toBe(true);
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.querySelector(".px")).toBeNull();

    root.unmount();
  });
});
