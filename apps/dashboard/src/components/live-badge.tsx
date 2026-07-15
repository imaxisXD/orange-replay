import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

const lightGridSize = 7;

type LightStyle = CSSProperties & {
  "--base": string;
  "--delay": string;
  "--dur": string;
};

type LiveDotSize = "default" | "sm" | "xs";

type LiveDotProps = {
  className?: string;
  size?: LiveDotSize;
};

const lightStyles: LightStyle[] = Array.from(
  { length: lightGridSize * lightGridSize },
  (_, index) => {
    const row = Math.floor(index / lightGridSize);
    const column = index % lightGridSize;
    const center = (lightGridSize - 1) / 2;
    const distance =
      Math.sqrt((column - center) ** 2 + (row - center) ** 2) /
      ((Math.SQRT2 * (lightGridSize - 1)) / 2);
    const jitter = (stableRandom(index * 3 + 1) - 0.5) * 0.22;

    return {
      "--base": Math.max(0.32, 1 - distance * 0.62 + jitter).toFixed(2),
      "--delay": `${(-stableRandom(index * 3 + 2) * 6).toFixed(2)}s`,
      "--dur": `${(3.2 + stableRandom(index * 3 + 3) * 2.8).toFixed(2)}s`,
    };
  },
);

export function LiveDot({ className, size = "default" }: LiveDotProps) {
  const showLightGrid = size === "default";

  return (
    <span
      aria-hidden="true"
      className={cn("live-dot", size !== "default" && `live-dot--${size}`, className)}
      data-slot="live-dot"
    >
      {showLightGrid && (
        <span className="live-dot__light" data-slot="live-dot-light">
          {lightStyles.map((style, index) => (
            <span className="px" key={index} style={style} />
          ))}
        </span>
      )}
    </span>
  );
}

export function LiveBadge({ className }: { className?: string }) {
  return (
    <span className={cn("live-badge", className)} data-slot="live-badge">
      <LiveDot />
      Live now
    </span>
  );
}

function stableRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43_758.5453;
  return value - Math.floor(value);
}
