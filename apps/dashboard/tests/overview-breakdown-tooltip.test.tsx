// @vitest-environment happy-dom
import { scaleBand, scaleLinear, scaleTime } from "@visx/scale";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ChartProvider, type ChartContextValue } from "../src/components/charts/chart-context";
import { DEFAULT_CHART_LIFECYCLE } from "../src/components/charts/chart-phase";
import { OverviewBreakdownTooltip } from "../src/routes/overview/overview-breakdown-tooltip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

const breakdowns = [
  ["Country", "Singapore", "from=1000&to=2000&country=SG"],
  ["City", "Singapore", "from=1000&to=2000&country=SG&city=Singapore"],
  ["Device type", "Desktop", "from=1000&to=2000&device=desktop"],
  ["Browser", "Chrome", "from=1000&to=2000&browser=Chrome"],
  ["OS", "macOS", "from=1000&to=2000&os=macOS"],
  ["Entry page", "/checkout", "from=1000&to=2000&entry_url=%2Fcheckout"],
] as const;

describe("Overview breakdown tooltip", () => {
  it.each(breakdowns)("shows the %s label instead of its internal filter", async (_, name, key) => {
    const point = { categoryKey: key, count: 1, name, share: 1 };
    const chartContainer = document.createElement("div");
    const reactContainer = document.createElement("div");
    document.body.append(chartContainer, reactContainer);
    const root = createRoot(reactContainer);

    await act(async () => {
      root.render(
        <ChartProvider value={chartValue(point, chartContainer)}>
          <OverviewBreakdownTooltip />
        </ChartProvider>,
      );
    });

    expect(chartContainer.textContent).toContain(name);
    expect(chartContainer.textContent).not.toContain(key);
    expect(chartContainer.textContent).not.toContain("from=");
    expect(chartContainer.textContent).not.toContain("to=");

    await act(async () => root.unmount());
  });
});

function chartValue(point: Record<string, unknown>, container: HTMLDivElement): ChartContextValue {
  const yScale = scaleLinear<number>({ domain: [0, 1], range: [160, 0] });
  const categoryKeyValue = point["categoryKey"];
  const categoryKey = typeof categoryKeyValue === "string" ? categoryKeyValue : "";

  return {
    ...DEFAULT_CHART_LIFECYCLE,
    data: [point],
    renderData: [point],
    xScale: scaleTime<number>({
      domain: [new Date(0), new Date(1)],
      range: [0, 320],
    }),
    yScale,
    yScales: { left: yScale },
    width: 400,
    height: 240,
    innerWidth: 320,
    innerHeight: 160,
    margin: { top: 40, right: 40, bottom: 40, left: 40 },
    columnWidth: 160,
    containerRef: { current: container },
    lines: [{ dataKey: "count", stroke: "var(--teal)", strokeWidth: 0 }],
    referenceAreas: [],
    isLoaded: true,
    animationDuration: 0,
    xAccessor: () => new Date(0),
    dateLabels: [],
    tooltipData: {
      point,
      index: 0,
      x: 160,
      yPositions: { count: 80 },
    },
    setTooltipData: vi.fn(),
    barScale: scaleBand<string>({ domain: [categoryKey], range: [0, 160] }),
    bandWidth: 30,
    barXAccessor: () => categoryKey,
    orientation: "horizontal",
    stacked: false,
  };
}
