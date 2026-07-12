import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { JourneyBreadcrumb } from "@/lib/replay-timeline";
import type { ReplayPlayerState } from "../use-replay-player";
import { journeyDisplayItems } from "./replay-markers";

export function JourneyBreadcrumbs({
  breadcrumbs,
  player,
}: {
  breadcrumbs: JourneyBreadcrumb[];
  player: ReplayPlayerState;
}) {
  const [expanded, setExpanded] = useState(false);
  if (breadcrumbs.length <= 1) {
    return null;
  }

  const currentBreadcrumb = breadcrumbs.findLast(
    (breadcrumb) => breadcrumb.offsetMs <= player.state.currentMs,
  );
  const visibleItems = journeyDisplayItems(breadcrumbs, expanded);

  return (
    <ScrollArea
      aria-label="Page journey"
      className="border-b border-dashed border-dash"
      data-testid="journey-breadcrumbs"
      orientation="horizontal"
      viewportClassName="scroll-fade-x"
    >
      <div className="flex w-max items-center gap-2 px-4 py-2.5">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.06em] text-dim">
          Journey
        </span>
        {visibleItems.map((item, index) => (
          <span className="inline-flex shrink-0 items-center gap-2" key={item.id}>
            {index > 0 && <span className="text-dim">·</span>}
            {"collapsedCount" in item ? (
              <Button
                aria-label={`Show ${item.collapsedCount} hidden pages`}
                className="h-6 rounded-full px-2 font-mono text-[11px] text-muted-foreground"
                onClick={() => setExpanded(true)}
                size="sm"
                variant="secondary"
              >
                +{item.collapsedCount}
              </Button>
            ) : (
              <Button
                active={currentBreadcrumb?.id === item.id}
                className={
                  currentBreadcrumb?.id === item.id
                    ? "h-6 max-w-50 rounded-full border-amber/40 px-2 font-mono text-[11px] text-amber"
                    : "h-6 max-w-50 rounded-full px-2 font-mono text-[11px] text-muted-foreground"
                }
                disabled={player.values.isFollowing}
                onClick={() => player.actions.seekTo(item.offsetMs, true)}
                size="sm"
                title={item.path}
                variant="secondary"
              >
                <span className="truncate">{item.path}</span>
              </Button>
            )}
          </span>
        ))}
      </div>
    </ScrollArea>
  );
}
