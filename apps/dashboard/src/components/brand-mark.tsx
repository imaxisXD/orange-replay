import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("h-6 w-8 shrink-0 object-contain", className)}
      src="/brand/orange-replay-logo-mark-white.webp"
    />
  );
}
