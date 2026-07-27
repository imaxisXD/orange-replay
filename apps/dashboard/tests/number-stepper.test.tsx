// @vitest-environment happy-dom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NumberStepper } from "../src/components/number-stepper";

vi.mock("@number-flow/react", () => ({
  default: ({ animated, value }: { animated: boolean; value: number }) => (
    <span data-animated={String(animated)} data-number-flow={value} />
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

describe("number stepper", () => {
  it("reports typed values and restores the controlled value for invalid input", () => {
    const { container, onChange, root } = renderStepper(30);
    const input = findInput(container);

    act(() => {
      input.value = "42";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(42);

    act(() => {
      input.value = "400";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(30);
    expect(input.value).toBe("30");

    root.unmount();
  });

  it("steps in both directions and disables buttons at the bounds", () => {
    const { container, onChange, root } = renderStepper(30);

    act(() => dispatchPointerDown(findButton(container, "Decrease Retention days")));
    expect(onChange).toHaveBeenLastCalledWith(29);

    act(() => dispatchPointerDown(findButton(container, "Increase Retention days")));
    expect(onChange).toHaveBeenLastCalledWith(31);

    flushSync(() =>
      root.render(
        <NumberStepper
          ariaLabel="Retention days"
          max={100}
          min={1}
          onChange={onChange}
          suffix="days"
          value={100}
        />,
      ),
    );
    expect(findButton(container, "Increase Retention days").disabled).toBe(true);
    expect(container.textContent).toContain("days");

    root.unmount();
  });
});

function renderStepper(value: number) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();

  flushSync(() =>
    root.render(
      <NumberStepper
        ariaLabel="Retention days"
        max={100}
        min={1}
        onChange={onChange}
        suffix="days"
        value={value}
      />,
    ),
  );

  return { container, onChange, root };
}

function findInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("input[aria-label='Retention days']");
  if (input === null) throw new Error("Could not find the retention input");
  return input;
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
  if (button === null) throw new Error(`Could not find ${label}`);
  return button;
}

function dispatchPointerDown(button: HTMLButtonElement): void {
  button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}
