import { useMemo, useState, type KeyboardEvent } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Elevated } from "@/lib/elevated";
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
import { CountryFlag } from "@/components/country-flag";
import { ApiError, listSessions, type SessionListItem } from "@/lib/api";
import { cleanCountryCode, formatLocationName } from "@/lib/country";
import {
  formatAbsoluteTime,
  formatBytes,
  formatDuration,
  formatErrorCount,
  formatShortRelativeTime,
} from "@/lib/format";
import { appendUniqueSessions, canLoadMore } from "@/lib/session-list";
import { defaultProjectId } from "@/lib/routes";
import { AlertCircle, ChevronRight, Inbox, RotateCcw, Search } from "@/lib/icon-map";
import { useShape } from "@/lib/shape-context";

const pageSize = 25;

const minDurationOptions = [
  { label: "Any duration", value: "any", ms: undefined },
  { label: "30 seconds", value: "30000", ms: 30_000 },
  { label: "1 minute", value: "60000", ms: 60_000 },
  { label: "5 minutes", value: "300000", ms: 300_000 },
] as const;

export function SessionsPage() {
  const params = useParams({ strict: false });
  const projectId = params.projectId ?? defaultProjectId;
  const [country, setCountry] = useState("");
  const [hasErrors, setHasErrors] = useState(false);
  const [minDurationValue, setMinDurationValue] = useState("any");

  const selectedMinDuration = minDurationOptions.find(
    (option) => option.value === minDurationValue,
  );

  const sessionsQuery = useInfiniteQuery({
    queryKey: [
      "sessions",
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

  const sessions = useMemo(
    () =>
      (sessionsQuery.data?.pages ?? []).reduce<SessionListItem[]>(
        (currentSessions, page) => appendUniqueSessions(currentSessions, page.sessions),
        [],
      ),
    [sessionsQuery.data?.pages],
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
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Sessions
          <span className="ml-2.5 text-[12px] font-normal text-dim">
            Watch how people actually used your product.
          </span>
        </h1>
      </div>

      <section className="lit session-table-panel overflow-hidden rounded-lg">
        <div className="flex items-center gap-2.5 border-b border-dashed border-dash px-4 py-3">
          <InputGroup className="w-40 gap-0">
            <InputField
              hideLabel
              icon={Search}
              index={0}
              label="Country code"
              onChange={setCountry}
              placeholder="Country code"
              value={country}
            />
          </InputGroup>

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
    </div>
  );
}

function SessionRow({
  index,
  projectId,
  session,
}: {
  index: number;
  projectId: string;
  session: SessionListItem;
}) {
  const navigate = useNavigate();
  const shape = useShape();
  const countryCode = cleanCountryCode(session.country);
  const location = formatLocationName(session.country, session.city);
  const metaParts = [location];
  if (session.clicks > 0) metaParts.push(`${session.clicks} clicks`);

  function openSession(): void {
    void navigate({
      to: "/projects/$projectId/sessions/$sessionId",
      params: { projectId, sessionId: session.session_id },
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSession();
  }

  return (
    <TableRow
      className="cursor-pointer"
      index={index}
      onClick={openSession}
      onKeyDown={handleKeyDown}
      role="link"
      tabIndex={0}
    >
      <TableCell>
        <div className="max-w-75 truncate text-[13px] font-medium text-foreground">
          {entryPath(session.entry_url)}
        </div>
        <div className="mt-0.5 flex max-w-75 items-center gap-1.5 text-[11.5px] text-dim">
          <CountryFlag country={countryCode} />
          <span className="truncate">{metaParts.join(" · ")}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1.5">
          {session.errors > 0 && (
            <Elevated className={`inline-flex ${shape.item}`} offset={4} shadowLevel={4}>
              <Badge color="red" size="sm" variant="dot">
                {formatErrorCount(session.errors)}
              </Badge>
            </Elevated>
          )}
          {session.rages > 0 && (
            <Elevated className={`inline-flex ${shape.item}`} offset={4} shadowLevel={4}>
              <Badge color="amber" size="sm" variant="dot">
                {session.rages} rage
              </Badge>
            </Elevated>
          )}
          {session.errors === 0 && session.rages === 0 && (
            <Elevated className={`inline-flex ${shape.item}`} offset={4} shadowLevel={4}>
              <Badge color="green" size="sm" variant="dot">
                clean
              </Badge>
            </Elevated>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right font-mono text-[12px] text-foreground">
        {formatDuration(session.duration_ms)}
      </TableCell>
      <TableCell>
        <span className="font-mono text-[12px] text-muted-foreground">
          {session.browser ?? "Unknown"}
          <span className="px-1 text-dim">·</span>
          {session.os ?? "Unknown"}
        </span>
      </TableCell>
      <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
        {formatBytes(session.bytes)}
      </TableCell>
      <TableCell
        className="text-right text-[12px] text-dim"
        title={formatAbsoluteTime(session.started_at)}
      >
        {formatShortRelativeTime(session.started_at)}
      </TableCell>
      <TableCell className="w-6 px-0">
        <ChevronRight
          aria-hidden
          className="size-4 text-dim opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
        />
      </TableCell>
    </TableRow>
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

function entryPath(value: string | null): string {
  if (value === null || value.length === 0) return "/";

  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
