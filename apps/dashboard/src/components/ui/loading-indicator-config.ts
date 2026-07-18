import type { GradientSpinProps } from "gradient-spin";

export const loadingIndicatorSettings = {
  gradient: [
    { color: "#FFE8A8", position: 0 },
    { color: "#F5A623", position: 0.33 },
    { color: "#FF735C", position: 0.67 },
    { color: "#4ED9C4", position: 1 },
  ],
  pattern: "diagonal",
  colorBy: "path",
  period: 350,
  dim: 0.03,
  rows: 3,
  cols: 5,
  cellSize: 3,
  cellGap: 2,
  cellRadius: 1,
  respectReducedMotion: true,
} satisfies Pick<
  GradientSpinProps,
  | "gradient"
  | "pattern"
  | "colorBy"
  | "period"
  | "dim"
  | "rows"
  | "cols"
  | "cellSize"
  | "cellGap"
  | "cellRadius"
  | "respectReducedMotion"
>;
