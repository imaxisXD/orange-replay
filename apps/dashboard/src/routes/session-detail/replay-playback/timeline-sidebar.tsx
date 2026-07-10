import { memo } from "react";
import type { TimelineDot, TimelineSidebarRow } from "@/lib/replay-timeline";
import {
  AlertCircle,
  Angry,
  ArrowUpRight,
  MousePointer,
  type IconComponent,
} from "../../../lib/icon-map";

export const TimelineSidebar = memo(function TimelineSidebar({
  disabled,
  onSeek,
  rows,
}: {
  disabled: boolean;
  onSeek: (timeMs: number) => void;
  rows: TimelineSidebarRow[];
}) {
  return (
    <aside className="lit flex h-full min-h-0 flex-col rounded-lg px-4 py-4 max-lg:max-h-90">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold">Timeline</h2>
        <span className="text-[11.5px] text-dim">{rows.length} events</span>
      </div>

      {rows.length === 0 ? (
        <div className="mt-4 flex min-h-35 items-center justify-center rounded-lg border border-dashed border-dash text-[12.5px] text-muted-foreground">
          No events captured in this session.
        </div>
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
          {rows.map((row) => {
            const kind = kindFor(row.dot);
            const KindIcon = kind.icon;
            return (
              <button
                className="flex w-full items-center gap-2.5 border-b border-dashed border-dash py-2 text-left outline-none transition-colors last:border-b-0 enabled:hover:bg-hover enabled:focus-visible:ring-1 enabled:focus-visible:ring-amber disabled:cursor-default"
                disabled={disabled}
                key={row.id}
                onClick={() => onSeek(row.offsetMs)}
                style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px" }}
                type="button"
              >
                {/* Shape + color double-encode the event kind — never color alone. */}
                <KindIcon aria-hidden className={`size-3.5 shrink-0 ${kind.className}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-foreground">{row.label}</span>
                  {row.detail !== undefined && (
                    <span className="block truncate font-mono text-[11px] text-dim">
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
        </div>
      )}
    </aside>
  );
});

function kindFor(dot: TimelineDot): { icon: IconComponent; className: string } {
  if (dot === "blue") return { icon: MousePointer, className: "text-player-blue" };
  if (dot === "danger") return { icon: AlertCircle, className: "text-danger" };
  if (dot === "amber") return { icon: Angry, className: "text-amber" };
  if (dot === "hollow") return { icon: MousePointer, className: "text-dim" };
  return { icon: ArrowUpRight, className: "text-teal" };
}
