import type { GradientSpinProps } from "gradient-spin";

export const loadingIndicatorSettings = {
  gradient: "sunrise",
  pattern: "diagonal",
  period: 550,
  dim: 0.05,
  rows: 3,
  cols: 5,
  cellSize: 3,
  cellGap: 2,
} satisfies Pick<
  GradientSpinProps,
  "gradient" | "pattern" | "period" | "dim" | "rows" | "cols" | "cellSize" | "cellGap"
>;
