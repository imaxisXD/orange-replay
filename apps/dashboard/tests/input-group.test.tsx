// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { InputField, InputGroup } from "../src/components/ui/input-group";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

describe("InputField events", () => {
  it("runs consumer focus handlers without replacing its own focus state", async () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Example() {
      const [value, setValue] = useState("");
      return (
        <InputGroup>
          <InputField
            index={0}
            label="Write key"
            onBlur={onBlur}
            onChange={setValue}
            onFocus={onFocus}
            value={value}
          />
        </InputGroup>
      );
    }

    await act(async () => root.render(<Example />));
    const input = container.querySelector("input");
    const frame = input?.closest('[role="presentation"]');

    await act(async () => input?.focus());
    expect(onFocus).toHaveBeenCalledOnce();
    expect(frame?.className).toContain("ring-amber");

    await act(async () => input?.blur());
    expect(onBlur).toHaveBeenCalledOnce();
    expect(frame?.className).toContain("ring-transparent");

    await act(async () => root.unmount());
  });
});
