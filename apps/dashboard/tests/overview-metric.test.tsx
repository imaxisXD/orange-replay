// @vitest-environment happy-dom
import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@number-flow/react", () => ({
  default: ({ suffix, value }: { suffix?: string; value: number }) => (
    <span data-number-flow={value} data-number-flow-suffix={suffix}>
      {suffix}
    </span>
  ),
  NumberFlowGroup: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../src/routes/overview/overview-doorways", () => ({
  InsightDoorway: MetricDoorway,
  KpiDoorway: MetricDoorway,
  LiveKpiDoorway: MetricDoorway,
}));

import { MetricPercentage, OverviewSummary } from "../src/routes/overview/overview-content";

describe("Overview metric typography", () => {
  it("keeps the percentage symbol inside the same number flow as its value", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<MetricPercentage isRatio value={0.247} />));

    const flow = container.querySelector("[data-number-flow]");
    expect(flow?.getAttribute("data-number-flow")).toBe("24.7");
    expect(flow?.getAttribute("data-number-flow-suffix")).toBe("%");
    expect(container.querySelector(".overview-metric-symbol")).toBeNull();

    root.unmount();
  });

  it("shows a missing percentage as zero with its symbol", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<MetricPercentage value={null} />));

    const flow = container.querySelector("[data-number-flow]");
    expect(flow?.getAttribute("data-number-flow")).toBe("0");
    expect(flow?.getAttribute("data-number-flow-suffix")).toBe("%");

    root.unmount();
  });

  it("initializes every Overview card with zero", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() =>
      root.render(<OverviewSummary filter={{}} isDemo projectId="project-1" stats={undefined} />),
    );

    expect(metricValues(container, "Sessions")).toEqual([0]);
    expect(metricValues(container, "Average session length")).toEqual([0, 0]);
    expect(metricValues(container, "Pages per session")).toEqual([0]);
    expect(metricValues(container, "Live now")).toEqual([0]);
    expect(metricValues(container, "Rage clicks")).toEqual([0]);
    expect(metricValues(container, "Quick returns")).toEqual([0]);
    expect(metricValues(container, "Interaction time")).toEqual([0, 0]);
    expect(metricValues(container, "Scroll depth")).toEqual([0]);
    expect(container.querySelector("[aria-label='No data']")).toBeNull();

    root.unmount();
  });
});

function MetricDoorway({ label, value }: { label: string; value: ReactNode }) {
  return <div data-overview-metric={label}>{value}</div>;
}

function metricValues(container: HTMLElement, label: string): number[] {
  const metric = container.querySelector(`[data-overview-metric='${label}']`);
  return Array.from(metric?.querySelectorAll("[data-number-flow]") ?? [], (element) =>
    Number(element.getAttribute("data-number-flow")),
  );
}
