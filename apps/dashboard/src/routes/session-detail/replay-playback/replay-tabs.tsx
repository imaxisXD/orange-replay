import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { ReplayPlayerState } from "../use-replay-player";

export function ReplayTabs({ player }: { player: ReplayPlayerState }) {
  const { tabs, selectedTab } = player.state;
  if (tabs.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-dashed border-dash px-4 py-2.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-dim">
        Replay tab
      </span>
      <Select
        value={selectedTab ?? tabs[0]!.id}
        onValueChange={(value) => player.actions.selectTab(value)}
      >
        <SelectTrigger aria-label="Replay tab" className="h-8 max-w-full sm:max-w-80" />
        <SelectContent>
          {tabs.map((tab, index) => (
            <SelectItem
              key={tab.id}
              value={tab.id}
              index={index}
              disabled={!player.values.canReadLiveHistory && tab.firstSnapshotAt === undefined}
            >
              {`${tab.label}${tab.path === undefined ? "" : ` · ${tab.path}`}${!player.values.canReadLiveHistory && tab.firstSnapshotAt === undefined ? " · Replay unavailable" : ""}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-[11px] text-muted-foreground">
        Dead clicks cover the loaded part of this tab.
      </span>
    </div>
  );
}
