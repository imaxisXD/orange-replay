import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type StatusPillKind = "ok" | "err" | "rage" | "neutral";

const statusPillClasses: Record<StatusPillKind, string> = {
  ok: "border border-border text-muted-foreground",
  err: "border border-[rgba(244,83,78,0.35)] bg-[rgba(244,83,78,0.07)] text-[#ffb3b0]",
  rage: "border border-[rgba(245,166,35,0.35)] bg-[rgba(245,166,35,0.07)] text-[#ffd9a0]",
  neutral: "border border-border text-muted-foreground",
};

const dotClasses: Record<Exclude<StatusPillKind, "neutral">, string> = {
  ok: "bg-success",
  err: "bg-danger",
  rage: "bg-amber",
};

export function StatusPill({
  children,
  className,
  kind,
}: {
  children: ReactNode;
  className?: string;
  kind: StatusPillKind;
}) {
  const showDot = kind !== "neutral";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-[6px] rounded-full px-[9px] py-[3px] text-[11px] font-medium",
        statusPillClasses[kind],
        className,
      )}
    >
      {showDot && (
        <span
          aria-hidden="true"
          className={cn("size-[6px] shrink-0 rounded-full", dotClasses[kind])}
        />
      )}
      <span className="[text-box:trim-both_cap_alphabetic]">{children}</span>
    </span>
  );
}
