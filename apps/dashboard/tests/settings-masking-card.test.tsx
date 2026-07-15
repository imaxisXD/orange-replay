// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MaskingCard } from "../src/routes/settings/settings-cards";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

describe("MaskingCard", () => {
  it("keeps the selector input mounted while its text changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const callbacks = {
      onAddRule: vi.fn(),
      onRemoveRule: vi.fn(),
      onSetAction: vi.fn(),
      onSetSelector: vi.fn(),
    };

    await act(async () => {
      root.render(
        <MaskingCard
          error={null}
          maskPolicyVersion={1}
          {...callbacks}
          rules={[{ uiId: "stable-rule", selector: ".one", action: "mask" }]}
        />,
      );
    });
    const originalInput = container.querySelector<HTMLInputElement>('input[type="text"]');
    await act(async () => originalInput?.focus());

    await act(async () => {
      root.render(
        <MaskingCard
          error={null}
          maskPolicyVersion={1}
          {...callbacks}
          rules={[{ uiId: "stable-rule", selector: ".two", action: "mask" }]}
        />,
      );
    });
    const updatedInput = container.querySelector<HTMLInputElement>('input[type="text"]');

    expect(updatedInput).toBe(originalInput);
    expect(document.activeElement).toBe(originalInput);
    expect(updatedInput?.value).toBe(".two");

    await act(async () => root.unmount());
  });
});
