// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DockBar } from "../src/components/dock-bar";
import { DashboardDockHost } from "../src/lib/dashboard-dock";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(Element.prototype, { getAnimations: () => [] });

afterEach(() => {
  document.body.replaceChildren();
});

describe("dock bar", () => {
  it("portals an open decision bar into the dashboard dock host", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DashboardDockHost>
          <DockBar open>
            <DockBar.Bar>
              <DockBar.Status>Unsaved changes</DockBar.Status>
              <DockBar.Message>Check the invalid rule.</DockBar.Message>
              <button type="button">Save changes</button>
            </DockBar.Bar>
          </DockBar>
        </DashboardDockHost>,
      );
    });

    expect(container.textContent).toContain("Unsaved changes");
    expect(container.textContent).toContain("Check the invalid rule.");
    expect(container.querySelector("button")?.textContent).toBe("Save changes");
    expect(container.querySelector(".dock-scrim")?.getAttribute("aria-hidden")).not.toBeNull();

    await act(async () => root.unmount());
  });
});
