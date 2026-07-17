import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared shell for the overview cards (Locations, Technology, Entry pages,
 * Browser errors). Compose the pieces instead of configuring one component:
 *
 *   <OverviewCard>
 *     <OverviewCardHeader>…title, tabs…</OverviewCardHeader>
 *     …body content…
 *     <OverviewCardFooter>…view all…</OverviewCardFooter>
 *   </OverviewCard>
 *
 * The card is a flex column with a reserved minimum height, so a footer pins
 * to the bottom edge via `mt-auto` regardless of how many rows sit above it.
 */
export function OverviewCard({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "lit overview-lit flex min-h-88 flex-col overflow-hidden rounded-lg",
        className,
      )}
      {...props}
    />
  );
}

export function OverviewCardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("border-b border-dashed border-dash px-4 py-3.5", className)} {...props} />
  );
}

export function OverviewCardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mt-auto border-t border-dashed border-dash px-4 py-1.5", className)}
      {...props}
    />
  );
}
