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
      <span className="absolute left-1 right-1 top-[10px] h-[2.5px] rounded-[2px] bg-[linear-gradient(90deg,#2dd4bf,#f5a623,#f4534e)]" />
    </span>
  );
}
