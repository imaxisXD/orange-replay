import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { AlertCircle, ChevronRight, Inbox, RotateCcw, Search } from "lucide-react";
import { StatusPill } from "@/components/status-pill";
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
import {
  formatAbsoluteTime,
  formatBytes,
  formatDuration,
  formatErrorCount,
  formatShortRelativeTime,
} from "@/lib/format";
import { appendUniqueSessions, canLoadMore } from "@/lib/session-list";
import { defaultProjectId } from "@/router";

const pageSize = 25;

const minDurationOptions = [
  { label: "Any duration", value: "any", ms: undefined },
  { label: "30 seconds", value: "30000", ms: 30_000 },
  { label: "1 minute", value: "60000", ms: 60_000 },
  { label: "5 minutes", value: "300000", ms: 300_000 },
] as const;

type LoadState = "idle" | "loading" | "loading_more";

export function SessionsPage() {
  const params = useParams();
  const projectId = params.projectId ?? defaultProjectId;
  const [country, setCountry] = useState("");
  const [hasErrors, setHasErrors] = useState(false);
  const [minDurationValue, setMinDurationValue] = useState("any");
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState("");

  const selectedMinDuration = minDurationOptions.find(
    (option) => option.value === minDurationValue,
  );

  const loadFirstPage = useCallback(async () => {
    setLoadState("loading");
    setError("");

    try {
      const page = await listSessions(projectId, {
        country,
        hasErrors,
        limit: pageSize,
        minDurationMs: selectedMinDuration?.ms,
      });
      setSessions(page.sessions);
      setNextBefore(page.nextBefore);
    } catch (caughtError) {
      setSessions([]);
      setNextBefore(null);
      setError(readErrorMessage(caughtError));
    } finally {
      setLoadState("idle");
    }
  }, [country, hasErrors, projectId, selectedMinDuration?.ms]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  async function loadMore(): Promise<void> {
    if (!canLoadMore(nextBefore) || loadState !== "idle") return;

    setLoadState("loading_more");
    setError("");

    try {
      const page = await listSessions(projectId, {
        before: nextBefore,
        country,
        hasErrors,
        limit: pageSize,
        minDurationMs: selectedMinDuration?.ms,
      });
      setSessions((currentSessions) => appendUniqueSessions(currentSessions, page.sessions));
      setNextBefore(page.nextBefore);
    } catch (caughtError) {
      setError(readErrorMessage(caughtError));
    } finally {
      setLoadState("idle");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Sessions
          <span className="ml-[10px] text-[12px] font-normal text-dim">
            Watch how people actually used your product.
          </span>
        </h1>
      </div>

      <section className="lit overflow-hidden rounded-lg">
        <div className="flex items-center gap-[10px] border-b border-dashed border-dash px-4 py-3">
          <InputGroup className="w-[160px] gap-0">
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
              className="h-[34px] min-w-[160px] rounded-[7px] border border-border bg-secondary px-3 text-[12px]"
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
              onClick={() => void loadFirstPage()}
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
  const href = `/projects/${projectId}/sessions/${session.session_id}`;
  const location = formatLocation(session.country, session.city);
  const metaParts = [location];
  if (session.clicks > 0) metaParts.push(`${session.clicks} clicks`);

  function openSession(): void {
    void navigate(href);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSession();
  }

  return (
    <TableRow
      className="cursor-pointer hover:bg-hover"
      index={index}
      onClick={openSession}
      onKeyDown={handleKeyDown}
      role="link"
      tabIndex={0}
    >
      <TableCell>
        <div className="max-w-[300px] truncate text-[13px] font-medium text-foreground">
          {entryPath(session.entry_url)}
        </div>
        <div className="mt-[2px] text-[11.5px] text-dim">{metaParts.join(" · ")}</div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-[6px]">
          {session.errors > 0 && (
            <StatusPill kind="err">{formatErrorCount(session.errors)}</StatusPill>
          )}
          {session.rages > 0 && <StatusPill kind="rage">{session.rages} rage</StatusPill>}
          {session.errors === 0 && session.rages === 0 && <StatusPill kind="ok">clean</StatusPill>}
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

function formatLocation(country: string | null, city: string | null): string {
  const cleanCity = city?.trim() ?? "";
  if (country === null || country.trim().length === 0) {
    return cleanCity.length > 0 ? cleanCity : "Unknown";
  }

  const code = country.trim().toUpperCase();
  const label = cleanCity.length > 0 ? cleanCity : code;
  return `${flagForCountry(code)} ${label}`;
}

function flagForCountry(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  const first = 0x1f1e6 + code.charCodeAt(0) - 65;
  const second = 0x1f1e6 + code.charCodeAt(1) - 65;
  return String.fromCodePoint(first, second);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
