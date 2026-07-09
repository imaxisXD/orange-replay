"use client";

import { type ReactNode } from "react";
import { AnimatePresence, m, useReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface IconSwapProps {
  /** Changing this key cross-fades the old glyph out and the new one in. */
  swapKey: string;
  children: ReactNode;
  className?: string;
}

/**
 * Cross-fades between two icon states (copy→check, play→pause) instead of a
 * hard cut. Both glyphs share one grid cell so they overlap during the swap.
 * Contextual icon animation values are fixed by convention: scale 0.25→1,
 * opacity 0→1, blur 4px→0, spring 0.3s with bounce 0. `initial={false}` skips
 * the animation on first mount; reduced-motion drops the transform/blur and
 * keeps a plain opacity fade.
 */
export function IconSwap({ swapKey, children, className }: IconSwapProps) {
  const reduce = useReducedMotion();

  return (
    <span className={cn("relative inline-grid place-items-center", className)}>
      <AnimatePresence initial={false}>
        <m.span
          key={swapKey}
          className="col-start-1 row-start-1 inline-grid place-items-center"
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          transition={reduce ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 }}
        >
          {children}
        </m.span>
      </AnimatePresence>
    </span>
  );
}
