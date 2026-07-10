import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

export type StatusPillKind = "ok" | "err" | "rage" | "neutral";

/**
 * Single source of truth for the design language's status pills
 * (docs/design-language.md §Components): full-radius, 11px medium, 6px dot.
 * Copy rules live with the pill: "clean", "N error(s)" pluralized,
 * "N rage" never pluralized.
 */
export function StatusPill({ kind, children }: { kind: StatusPillKind; children: ReactNode }) {
  if (kind === "err") {
    return (
      <Badge
        className="rounded-full"
        color="red"
        size="sm"
        style={{
          color: "#ffb3b0",
          backgroundColor: "rgba(244,83,78,0.07)",
          borderColor: "rgba(244,83,78,0.35)",
        }}
        variant="dot"
      >
        {children}
      </Badge>
    );
  }

  if (kind === "rage") {
    return (
      <Badge
        className="rounded-full"
        color="amber"
        size="sm"
        style={{
          color: "#ffd9a0",
          backgroundColor: "rgba(245,166,35,0.07)",
          borderColor: "rgba(245,166,35,0.35)",
        }}
        variant="dot"
      >
        {children}
      </Badge>
    );
  }

  if (kind === "ok") {
    return (
      <Badge className="rounded-full text-muted-foreground" color="green" size="sm" variant="dot">
        {children}
      </Badge>
    );
  }

  return (
    <Badge className="rounded-full" color="gray" size="sm">
      {children}
    </Badge>
  );
}
