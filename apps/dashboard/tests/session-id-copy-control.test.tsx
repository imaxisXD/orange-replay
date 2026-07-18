// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SessionIdCopyControl } from "../src/routes/sessions/session-stage";

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
  vi.unstubAllGlobals();
});

describe("Session ID copy control", () => {
  it("copies the ID without adding a tooltip to the straightforward action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await act(async () => {
      root.render(<SessionIdCopyControl sessionId="session-123456789" />);
    });

    const button = container.querySelector<HTMLButtonElement>("button");

    expect(button?.textContent).toContain("Session ID");
    expect(button?.textContent).toContain("session-…");
    expect(button?.getAttribute("aria-label")).toBe("Copy session ID");
    expect(container.querySelector("[data-morph-tooltip-trigger]")).toBeNull();
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("session-123456789");
    expect(button?.getAttribute("aria-label")).toBe("Session ID copied");
  });
});
