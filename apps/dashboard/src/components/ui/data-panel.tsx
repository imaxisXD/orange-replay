import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const panelClassName = "lit flex flex-col overflow-hidden rounded-lg";

/**
 * Shared shell for dense evidence lists and tables. Compose the sections a
 * surface needs instead of adding header/footer flags to one large component.
 */
export function DataPanel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn(panelClassName, className)} {...props} />;
}

/** Semantic side-panel variant for evidence beside the primary content. */
export function DataPanelAside({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <aside className={cn(panelClassName, className)} {...props} />;
}

export function DataPanelHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("border-b border-dashed border-dash px-4 py-3.5", className)} {...props} />
  );
}

export function DataPanelBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-h-0 flex-1", className)} {...props} />;
}

export function DataPanelFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mt-auto border-t border-dashed border-dash px-4 py-1.5", className)}
      {...props}
    />
  );
}
