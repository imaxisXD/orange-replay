import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex size-6 shrink-0 rounded-[7px] border border-dash bg-secondary",
        className,
      )}
    >
      <span className="absolute left-1 right-1 top-2.5 h-[2.5px] rounded-xs bg-[linear-gradient(90deg,var(--teal),var(--amber),var(--danger))]" />
    </span>
  );
}
