// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SettingsNav } from "../src/routes/settings/settings-nav";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(Element.prototype, { getAnimations: () => [] });

afterEach(() => {
  document.body.replaceChildren();
});

describe("settings navigation", () => {
  it("shows every section and reports the selected section", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSelect = vi.fn();

    await act(async () => {
      root.render(<SettingsNav active="capture" onSelect={onSelect} />);
    });

    expect(container.textContent).toContain("Recording");
    expect(container.textContent).toContain("Access & sharing");
    expect(container.textContent).toContain("System");
    expect(
      Array.from(container.querySelectorAll("[data-nav-index]"), (row) => row.textContent),
    ).toEqual([
      "Capture",
      "Masking",
      "Allowed origins",
      "Recorder keys",
      "Public page",
      "Environment",
    ]);
    expect(findButton(container, "Capture").getAttribute("aria-current")).toBe("true");

    await act(async () => findButton(container, "Recorder keys").click());
    expect(onSelect).toHaveBeenCalledWith("keys");

    await act(async () => {
      root.render(<SettingsNav active="keys" onSelect={onSelect} />);
    });
    expect(findButton(container, "Recorder keys").getAttribute("aria-current")).toBe("true");
    expect(findButton(container, "Capture").hasAttribute("aria-current")).toBe(false);

    await act(async () => root.unmount());
  });

  it("treats a group heading as a shortcut to that group's first section", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSelect = vi.fn();

    await act(async () => {
      root.render(<SettingsNav active="capture" onSelect={onSelect} />);
    });

    await act(async () => findButton(container, "Access & sharing").click());
    expect(onSelect).toHaveBeenCalledWith("keys");

    await act(async () => findButton(container, "System").click());
    expect(onSelect).toHaveBeenCalledWith("environment");

    await act(async () => root.unmount());
  });
});

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`Could not find ${label} settings button`);
  return button;
}
