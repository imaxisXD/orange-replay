// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import {
  DataPanel,
  DataPanelAside,
  DataPanelBody,
  DataPanelFooter,
  DataPanelHeader,
} from "../src/components/ui/data-panel";

describe("data panel", () => {
  it("composes the shared shell, header, body, and footer", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DataPanel aria-label="Sessions">
          <DataPanelHeader>Header</DataPanelHeader>
          <DataPanelBody>Rows</DataPanelBody>
          <DataPanelFooter>Footer</DataPanelFooter>
        </DataPanel>,
      );
    });

    const panel = container.querySelector("section");
    expect(panel?.className).toContain("overflow-hidden");
    expect(panel?.children[0]?.className).toContain("border-b");
    expect(panel?.children[1]?.className).toContain("flex-1");
    expect(panel?.children[2]?.className).toContain("border-t");

    await act(async () => root.unmount());
  });

  it("keeps supporting evidence semantic with the aside variant", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(<DataPanelAside aria-label="Timeline" />);
    });

    expect(container.querySelector("aside")?.className).toContain("lit");

    await act(async () => root.unmount());
  });
});
