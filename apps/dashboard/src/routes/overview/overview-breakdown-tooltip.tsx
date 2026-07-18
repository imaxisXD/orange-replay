import { ChartTooltip } from "@/components/charts/tooltip";
import { percentFormatter } from "./overview-format";

function displayTitle(point: Record<string, unknown>): string | undefined {
  const name = point["name"];
  return typeof name === "string" ? name : undefined;
}

export function OverviewBreakdownTooltip() {
  return (
    <ChartTooltip
      rows={(point) => [
        {
          color: "var(--teal)",
          label: "Sessions",
          value: Number(point["count"] ?? 0),
        },
        {
          color: "var(--muted-foreground)",
          label: "Share",
          value: percentFormatter.format(Number(point["share"] ?? 0)),
        },
      ]}
      showCrosshair={false}
      showDatePill={false}
      showDots={false}
      title={displayTitle}
    />
  );
}
