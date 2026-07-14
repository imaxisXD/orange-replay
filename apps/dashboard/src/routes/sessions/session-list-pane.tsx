import type { KeyboardEvent, RefObject } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { SessionDisplayItem } from "@/lib/session-list";
import { Check, Inbox, Search } from "@/lib/icon-map";
import type { SessionSort } from "@/lib/sessions-view-search";
import { cn } from "@/lib/utils";
import { SessionCard } from "./session-card";

const sortOptions: { label: string; value: SessionSort }[] = [
  { label: "Newest", value: "newest" },
  { label: "Most friction", value: "friction" },
  { label: "Longest", value: "duration" },
  { label: "Most clicks", value: "clicks" },
  { label: "Most pages", value: "pages" },
];

export type SessionListLoadState = "loading" | "loading_more" | "idle";

export function SessionListPane({
  className,
  chipsCount,
  error,
  hasMore,
  loadState,
  onClearFilters,
  onLoadMore,
  onRailKeyDown,
  onSelect,
  onShowAll,
  onSortChange,
  onToggleUnwatched,
  railRef,
  selected,
  sessions,
  sort,
  unwatchedOnly,
  visibleSessions,
  watched,
}: {
  className?: string;
  chipsCount: number;
  error: string;
  hasMore: boolean;
  loadState: SessionListLoadState;
  onClearFilters: () => void;
  onLoadMore: () => Promise<void>;
  onRailKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSelect: (session: SessionDisplayItem) => void;
  onShowAll: () => void;
  onSortChange: (sort: SessionSort) => void;
  onToggleUnwatched: () => void;
  railRef: RefObject<HTMLDivElement | null>;
  selected: string | undefined;
  sessions: readonly SessionDisplayItem[];
  sort: SessionSort;
  unwatchedOnly: boolean;
  visibleSessions: readonly SessionDisplayItem[];
  watched: ReadonlySet<string>;
}) {
  const selectedIsVisible = visibleSessions.some((session) => session.session_id === selected);

  return (
    <section
      className={cn(
        "lit w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-lg lg:w-80",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-dashed border-dash px-4 py-2.5">
        <span className="text-[11px] font-medium tracking-[0.06em] text-dim uppercase">Sort</span>
        <Select onValueChange={(value) => onSortChange(value as SessionSort)} value={sort}>
          <SelectTrigger
            aria-label="Sort sessions"
            className="h-7.5 min-w-32 rounded-[7px] border border-border bg-secondary px-2.5 text-[12px]"
            placeholder="Newest"
          />
          <SelectContent className="rounded-lg border border-border bg-popover">
            <SelectGroup>
              {sortOptions.map((option, index) => (
                <SelectItem index={index} key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <div className="flex-1" />

        <Switch
          checked={unwatchedOnly}
          className="min-h-11 px-0 py-0 lg:min-h-0"
          label="Unwatched"
          onToggle={onToggleUnwatched}
        />
      </div>

      <ScrollArea
        aria-label="Sessions"
        className="h-[calc(100dvh-390px)] min-h-80 lg:h-[calc(100vh-370px)] lg:min-h-40"
        onKeyDown={onRailKeyDown}
        ref={railRef}
        role="listbox"
        viewportClassName="scroll-fade"
      >
        {loadState === "loading" ? (
          <LoadingCards />
        ) : (
          visibleSessions.map((session, index) => (
            <SessionCard
              isSelected={session.session_id === selected}
              isTabStop={session.session_id === selected || (!selectedIsVisible && index === 0)}
              isWatched={watched.has(session.session_id)}
              key={session.session_id}
              onSelect={() => onSelect(session)}
              session={session}
            />
          ))
        )}

        {loadState !== "loading" && sessions.length === 0 && error.length === 0 && (
          <div className="p-4">
            {chipsCount > 0 ? (
              <FilteredEmptyState count={chipsCount} onClear={onClearFilters} />
            ) : (
              <SessionsEmptyState />
            )}
          </div>
        )}

        {loadState !== "loading" && sessions.length > 0 && visibleSessions.length === 0 && (
          <AllWatchedState onShowAll={onShowAll} total={sessions.length} />
        )}
      </ScrollArea>

      {hasMore && (
        <div className="flex justify-center border-t border-dashed border-dash px-4 py-2.5">
          <Button
            className="rounded-lg border border-border bg-card text-[12.5px] font-medium text-foreground"
            disabled={loadState !== "idle"}
            loading={loadState === "loading_more"}
            onClick={() => void onLoadMore()}
            size="sm"
            variant="secondary"
          >
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

function LoadingCards() {
  return Array.from({ length: 5 }, (_, index) => (
    <div className="border-b border-dashed border-dash px-4 py-3 last:border-b-0" key={index}>
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-12" />
      </div>
      {/* Most real rows carry no pills — the skeleton promises only the spark. */}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Skeleton className="h-4 w-21" />
      </div>
      <Skeleton className="mt-2 h-3.5 w-52" />
    </div>
  ));
}

function FilteredEmptyState({ count, onClear }: { count: number; onClear: () => void }) {
  return (
    <Empty className="border border-dashed border-dash">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Search aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No sessions match these filters</EmptyTitle>
        <EmptyDescription>
          {count === 1 ? "1 filter is" : `${count} filters are`} narrowing this list to nothing.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onClear} variant="secondary">
          Clear filters
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function AllWatchedState({ onShowAll, total }: { onShowAll: () => void; total: number }) {
  return (
    <div className="p-4">
      <Empty className="border border-dashed border-dash">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Check aria-hidden />
          </EmptyMedia>
          <EmptyTitle>All caught up</EmptyTitle>
          <EmptyDescription>
            You have watched every one of the {total} sessions here.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onShowAll} variant="secondary">
            Show all sessions
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

function SessionsEmptyState() {
  return (
    <Empty className="border border-dashed border-dash">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No sessions yet</EmptyTitle>
        <EmptyDescription>
          Install the snippet and sessions appear here on their own.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent />
    </Empty>
  );
}
