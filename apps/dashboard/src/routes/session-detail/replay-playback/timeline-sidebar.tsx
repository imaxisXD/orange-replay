import { memo } from "react";
import { DataPanelAside, DataPanelBody, DataPanelHeader } from "@/components/ui/data-panel";
import type { SidebarEventKind, TimelineDot, TimelineSidebarRow } from "@/lib/replay-timeline";
import { ScrollArea } from "../../../components/ui/scroll-area";
import {
  AlertCircle,
  Angry,
  ArrowUpRight,
  MousePointer,
  MouseScroll,
  Tag,
  type IconComponent,
} from "../../../lib/icon-map";

export const TimelineSidebar = memo(function TimelineSidebar({
  disabled,
  onSeek,
  rows,
  tabLabels,
}: {
  disabled: boolean;
  onSeek: (timeMs: number, tab?: string) => void;
  rows: TimelineSidebarRow[];
  tabLabels?: ReadonlyMap<string, string>;
}) {
  return (
    <DataPanelAside className="h-full min-h-0 px-4 py-4 max-lg:max-h-90">
      <DataPanelHeader className="flex items-center justify-between gap-3 border-b-0 px-0 py-0">
        <h2 className="text-[13px] font-semibold leading-tight">Timeline</h2>
        <span className="text-[11.5px] text-dim">
          {rows.length} {rows.length === 1 ? "event" : "events"}
        </span>
      </DataPanelHeader>

      <DataPanelBody className="flex flex-col">
        {rows.length === 0 ? (
          <div className="mt-4 flex min-h-35 items-center justify-center rounded-lg border border-dashed border-dash text-[12.5px] text-muted-foreground">
            No events captured in this session.
          </div>
        ) : (
          <ScrollArea className="-mx-4 mt-3 min-h-0 flex-1" viewportClassName="scroll-fade">
            {rows.map((row) => {
              const KindIcon = iconFor(row.type);
              return (
                <button
                  className="flex w-full items-center gap-2.5 border-b border-dashed border-dash px-4 py-2.5 text-left outline-none transition-[background-color,box-shadow] duration-150 last:border-b-0 enabled:hover:bg-hover enabled:focus-visible:bg-active enabled:focus-visible:shadow-[inset_0_0_0_1px_var(--amber)] disabled:cursor-default"
                  data-slot="timeline-event-row"
                  disabled={disabled}
                  key={row.id}
                  onClick={() => onSeek(row.offsetMs, row.tab)}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px" }}
                  title={row.detail === undefined ? row.label : `${row.label}: ${row.detail}`}
                  type="button"
                >
                  {/* Shape + color double-encode the event kind — never color alone. */}
                  <KindIcon aria-hidden className={`size-3.5 shrink-0 ${colorFor(row.dot)}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-foreground">
                      {row.label}
                      {row.tab !== undefined && tabLabels?.has(row.tab) && (
                        <span className="ml-2 text-[11px] text-dim">{tabLabels.get(row.tab)}</span>
                      )}
                    </span>
                    {row.detail !== undefined && (
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {row.detail}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                    {row.offsetLabel}
                  </span>
                </button>
              );
            })}
          </ScrollArea>
        )}
      </DataPanelBody>
    </DataPanelAside>
  );
});

function iconFor(type: SidebarEventKind): IconComponent {
  if (type === "error") return AlertCircle;
  if (type === "rage") return Angry;
  if (type === "nav") return ArrowUpRight;
  if (type === "scroll") return MouseScroll;
  if (type === "custom") return Tag;
  return MousePointer;
}

function colorFor(dot: TimelineDot): string {
  if (dot === "blue") return "text-player-blue";
  if (dot === "danger") return "text-danger";
  if (dot === "amber") return "text-amber";
  if (dot === "success") return "text-success";
  if (dot === "hollow" || dot === "dim") return "text-dim";
  return "text-teal";
}
