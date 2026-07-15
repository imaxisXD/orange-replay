import type { CSSProperties } from "react";
import { GradientSpin } from "gradient-spin";
import { cn } from "@/lib/utils";
import { loadingIndicatorSettings } from "./loading-indicator-config";

interface LoadingIndicatorProps {
  className?: string;
  label: string;
  style?: CSSProperties;
}

function LoadingIndicator({ className, label, style }: LoadingIndicatorProps) {
  return (
    <GradientSpin
      {...loadingIndicatorSettings}
      className={className}
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
