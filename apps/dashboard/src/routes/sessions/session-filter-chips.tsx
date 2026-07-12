import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { FilterChip } from "@/lib/filter-chips";
import { X } from "@/lib/icon-map";

export function SessionFilterChips({
  chips,
  onClear,
  onRemove,
}: {
  chips: readonly FilterChip[];
  onClear: () => void;
  onRemove: (key: string) => void;
}) {
  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11.5px] text-dim">Filters</span>
      {chips.map((chip) => (
        <button
          aria-label={`Remove filter: ${chip.label}`}
          className="group/chip inline-flex min-h-11 cursor-pointer items-center sm:min-h-0"
          key={chip.key}
          onClick={() => onRemove(chip.key)}
          type="button"
        >
          <Badge className="pr-1.5" color="gray" size="sm">
            <span className="flex items-center gap-1">
              {chip.label}
              <X
                aria-hidden
                className="size-3 text-dim transition-colors group-hover/chip:text-foreground"
              />
            </span>
          </Badge>
        </button>
      ))}
      <Button className="ml-auto h-auto px-0 py-0 text-[11.5px]" onClick={onClear} variant="ghost">
        Clear filters
      </Button>
    </div>
  );
}
