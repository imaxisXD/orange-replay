import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputField, InputGroup } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, listSessions, type SessionListItem } from "@/lib/api";
import { AlertCircle, Inbox, RotateCcw, Search } from "@/lib/icon-map";
import { appendUniqueSessions, canLoadMore } from "@/lib/session-list";
import { SessionRow } from "./session-row";

const pageSize = 25;

const minDurationOptions = [
  { label: "Any duration", value: "any", ms: undefined },
  { label: "30 seconds", value: "30000", ms: 30_000 },
  { label: "1 minute", value: "60000", ms: 60_000 },
  { label: "5 minutes", value: "300000", ms: 300_000 },
] as const;

export function SessionsPanel({ isDemo, projectId }: { isDemo: boolean; projectId: string }) {
  const [country, setCountry] = useState("");
  const [hasErrors, setHasErrors] = useState(false);
  const [minDurationValue, setMinDurationValue] = useState("any");

  const selectedMinDuration = minDurationOptions.find(
    (option) => option.value === minDurationValue,
  );

  const sessionsQuery = useInfiniteQuery({
    queryKey: [
      "sessions",
      isDemo ? "demo" : "private",
      projectId,
      country.trim().toUpperCase(),
      hasErrors,
      selectedMinDuration?.ms ?? null,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      listSessions(
        projectId,
        {
          before: pageParam,
          country,
          hasErrors,
          limit: pageSize,
          minDurationMs: selectedMinDuration?.ms,
        },
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.nextBefore,
  });

  const sessions = (sessionsQuery.data?.pages ?? []).reduce<SessionListItem[]>(
    (currentSessions, page) => appendUniqueSessions(currentSessions, page.sessions),
    [],
  );
  const nextBefore = sessionsQuery.data?.pages.at(-1)?.nextBefore ?? null;
  const loadState = sessionsQuery.isPending
    ? "loading"
    : sessionsQuery.isFetchingNextPage
      ? "loading_more"
      : "idle";
  const error = sessionsQuery.error === null ? "" : readErrorMessage(sessionsQuery.error);

  async function loadMore(): Promise<void> {
    if (!canLoadMore(nextBefore) || loadState !== "idle") return;
    await sessionsQuery.fetchNextPage();
  }

  return (
    <section className="lit session-table-panel overflow-hidden rounded-lg">
      <div className="flex items-center gap-2.5 border-b border-dashed border-dash px-4 py-3">
        <CountryFilter onCommit={setCountry} value={country} />

        <Select onValueChange={setMinDurationValue} value={minDurationValue}>
          <SelectTrigger
            aria-label="Minimum duration"
            className="h-8.5 min-w-40 rounded-[7px] border border-border bg-secondary px-3 text-[12px]"
            placeholder="Any duration"
          />
          <SelectContent className="rounded-lg border border-border bg-popover">
            <SelectGroup>
              {minDurationOptions.map((option, index) => (
                <SelectItem index={index} key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <Switch
          checked={hasErrors}
          className="px-0 py-0"
          label="Has errors"
          onToggle={() => setHasErrors((currentValue) => !currentValue)}
        />

        <div className="flex-1" />

        <span className="font-mono text-[11.5px] text-dim">{sessions.length} sessions</span>
        <Tooltip content="Refresh">
          <Button
            aria-label="Refresh"
            className="text-muted-foreground hover:text-foreground"
            disabled={loadState === "loading"}
            onClick={() => void sessionsQuery.refetch()}
            size="icon-sm"
            variant="ghost"
          >
            <RotateCcw aria-hidden className="size-4" />
          </Button>
        </Tooltip>
      </div>

      {error.length > 0 && (
        <div className="px-4 py-3">
          <Alert variant="destructive">
            <AlertCircle aria-hidden />
            <AlertTitle>Could not load sessions</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">When</TableHead>
              <TableHead aria-hidden className="w-6 px-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadState === "loading" ? (
              <LoadingRows />
            ) : (
              sessions.map((session, index) => (
                <SessionRow
                  isDemo={isDemo}
                  index={index}
                  key={session.session_id}
                  projectId={projectId}
                  session={session}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {loadState !== "loading" && sessions.length === 0 && error.length === 0 && (
        <div className="p-4">
          <SessionsEmptyState />
        </div>
      )}

      {canLoadMore(nextBefore) && (
        <div className="flex justify-center border-t border-dashed border-dash px-4 py-3">
          <Button
            className="rounded-lg border border-border bg-card text-[12.5px] font-medium text-foreground"
            disabled={loadState !== "idle"}
            loading={loadState === "loading_more"}
            onClick={() => void loadMore()}
            variant="secondary"
          >
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

function CountryFilter({
  onCommit,
  value,
}: {
  onCommit: (country: string) => void;
  value: string;
}) {
  const [input, setInput] = useState(value);

  function commitCountry(nextValue: string): void {
    const cleanValue = nextValue.trim();
    if (cleanValue.length === 0 || cleanValue.length === 2) {
      onCommit(cleanValue);
    }
  }

  return (
    <InputGroup className="w-40 gap-0">
      <InputField
        hideLabel
        icon={Search}
        index={0}
        label="Country code"
        maxLength={2}
        onBlur={() => commitCountry(input)}
        onChange={(nextValue) => {
          const upperValue = nextValue.toUpperCase();
          setInput(upperValue);
          commitCountry(upperValue);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitCountry(input);
        }}
        placeholder="Country code"
        value={input}
      />
    </InputGroup>
  );
}

function LoadingRows() {
  return Array.from({ length: 5 }, (_, index) => (
    <TableRow index={index} key={index}>
      {Array.from({ length: 7 }, (_unused, cellIndex) => (
        <TableCell
          className={cellIndex >= 2 && cellIndex !== 3 ? "text-right" : ""}
          key={cellIndex}
        >
          <Skeleton className="h-5 w-full" />
        </TableCell>
      ))}
    </TableRow>
  ));
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
          Captured sessions will appear here when your app sends data.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent />
    </Empty>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
