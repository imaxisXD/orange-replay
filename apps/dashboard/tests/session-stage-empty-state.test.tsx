// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EmptySessionStage } from "../src/routes/sessions/session-stage";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

describe("session stage empty states", () => {
  it("shows the rooster scene only when the user has not selected a session", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<EmptySessionStage />);
    });
    expect(findMainArtwork(container).src).toContain("select-session-reader");
    expect(container.querySelectorAll("[data-parallax-movement]").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("The rooster has the reel");
    expect(container.textContent).not.toContain("Nothing to watch yet");

    await act(async () => root.unmount());
  });
});

function findMainArtwork(container: HTMLElement): HTMLImageElement {
  const artwork = container.querySelector<HTMLImageElement>('img[aria-hidden="true"]');
  if (artwork === null) throw new Error("Could not find the rooster artwork");
  return artwork;
}
