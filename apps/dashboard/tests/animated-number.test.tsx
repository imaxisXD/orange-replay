// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { AnimatedDuration, AnimatedNumber } from "../src/components/animated-number";

vi.mock("@number-flow/react", () => ({
  default: ({ ref, value }: { ref?: (element: HTMLSpanElement | null) => void; value: number }) => (
    <span data-number-flow={value} ref={ref} />
  ),
  NumberFlowGroup: ({ children }: { children: ReactNode }) => children,
}));

describe("animated dashboard numbers", () => {
  it("starts an uninitialized value at zero and accepts the fetched value", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<AnimatedNumber value={undefined} />));
    expect(numberValues(container)).toEqual([0]);

    flushSync(() => root.render(<AnimatedNumber value={24} />));
    expect(numberValues(container)).toEqual([24]);

    root.unmount();
  });

  it("keeps missing data distinct from a real zero", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<AnimatedNumber value={null} />));

    expect(container.textContent).toBe("—");
    expect(container.querySelector("[aria-label='No data']")).not.toBeNull();

    root.unmount();
  });

  it("animates an already fetched value from zero when it mounts", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<AnimatedNumber startFromZero value={24} />));
    expect(numberValues(container)).toEqual([0]);

    await act(async () => undefined);
    expect(numberValues(container)).toEqual([24]);

    root.unmount();
  });

  it("formats a duration as grouped animated time parts", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<AnimatedDuration value={65_000} />));

    expect(numberValues(container)).toEqual([1, 5]);
    expect(container.querySelector("[aria-label='1:05']")).not.toBeNull();
    expect(container.querySelectorAll("[aria-hidden='true']")).toHaveLength(1);

    root.unmount();
  });
});

function numberValues(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll("[data-number-flow]"), (element) =>
    Number(element.getAttribute("data-number-flow")),
  );
}
