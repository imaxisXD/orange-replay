import type { ChartPhase } from "./chart-phase";

export type YDomain = [number, number];

/** Phases where the chart shows loading chrome (shimmer, pulse, label). */
export function isLoadingChromePhase(phase: ChartPhase): boolean {
  return phase === "loading" || phase === "revealingLoading";
}

/** Phases where grid lines use loading stroke styling (muted / dashed chrome). */
export function isLoadingGridChromePhase(phase: ChartPhase): boolean {
  return phase === "loading" || phase === "exiting" || phase === "gridTweenLoading";
}
