import type { CSSProperties } from "react";
import { GradientSpin, type GradientSpinProps } from "gradient-spin";
import { cn } from "@/lib/utils";

const loadingIndicatorSettings = {
  gradient: "sunrise",
  pattern: "snake",
  period: 750,
  dim: 0.07,
  rows: 3,
  cols: 5,
  cellSize: 4,
  cellGap: 2,
} satisfies Pick<
  GradientSpinProps,
  "gradient" | "pattern" | "period" | "dim" | "rows" | "cols" | "cellSize" | "cellGap"
>;

interface LoadingIndicatorProps {
  className?: string;
  label: string;
  style?: CSSProperties;
}

function LoadingIndicator({ className, label, style }: LoadingIndicatorProps) {
  return (
    <GradientSpin
      {...loadingIndicatorSettings}
      className={cn("shrink-0", className)}
      data-slot="loading-indicator"
      label={label}
      style={style}
    />
  );
}

function LoadingArea({ className, label }: { className?: string; label: string }) {
  return (
    <div
      className={cn("flex min-w-0 items-center justify-center", className)}
      data-slot="loading-area"
    >
      <LoadingIndicator label={label} />
    </div>
  );
}

export { LoadingArea, LoadingIndicator };
export type { LoadingIndicatorProps };
