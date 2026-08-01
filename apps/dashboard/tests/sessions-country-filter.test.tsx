// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SessionsToolbar } from "../src/routes/sessions/sessions-toolbar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("sessions country fallback", () => {
  it("blocks malformed input, then commits Cloudflare's Tor code with Enter", async () => {
    const onFilterChange = vi.fn();
    await act(async () => {
      root.render(
        <SessionsToolbar
          countries={[]}
          countryQueryFailed
          countryQueryPending={false}
          filter={{}}
          onFilterChange={onFilterChange}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[placeholder="Country code"]')!;
    await act(async () => setInputValue(input, "1A"));
    expect(onFilterChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Use a two-character country code.");

    await act(async () => {
      setInputValue(input, "t1");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onFilterChange).toHaveBeenLastCalledWith({ country: "T1" });
  });
});

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
