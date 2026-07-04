import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { AlertCircle, Inbox, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { formatAbsoluteTime, formatBytes, formatDuration, formatRelativeTime } from "@/lib/format";
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
    <div className="flex flex-col gap-6">
      <PageHeader
        description="List view for captured sessions. Playback lands in T3.3."
        title="Sessions"
      />

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-surface-1">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <InputGroup className="w-full md:w-64">
              <InputField
                index={0}
                label="Country"
                onChange={setCountry}
                placeholder="US"
                value={country}
              />
            </InputGroup>

            <div className="flex flex-col gap-1">
              <span className="px-3 text-[13px] text-muted-foreground">Minimum duration</span>
              <Select onValueChange={setMinDurationValue} value={minDurationValue}>
                <SelectTrigger aria-label="Minimum duration" placeholder="Any duration" />
                <SelectContent>
                  <SelectGroup>
                    {minDurationOptions.map((option, index) => (
                      <SelectItem index={index} key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <Switch
              checked={hasErrors}
              label="Has errors"
              onToggle={() => setHasErrors((currentValue) => !currentValue)}
            />
          </div>

          <Button
            disabled={loadState === "loading"}
            leadingIcon={RotateCcw}
            onClick={() => void loadFirstPage()}
            size="sm"
            variant="tertiary"
          >
            Refresh
          </Button>
        </div>

        {error.length > 0 && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden />
            <AlertTitle>Could not load sessions</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Start time</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Entry page</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Browser</TableHead>
                <TableHead>OS</TableHead>
                <TableHead>Bytes</TableHead>
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

        {loadState !== "loading" && sessions.length === 0 && <SessionsEmptyState />}

        <div className="flex justify-center">
          <Button
            disabled={!canLoadMore(nextBefore) || loadState !== "idle"}
            loading={loadState === "loading_more"}
            onClick={() => void loadMore()}
            variant="secondary"
          >
            Load more
          </Button>
        </div>
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
  const href = `/projects/${projectId}/sessions/${session.session_id}`;
  const country = session.country ?? "Unknown";
  const browser = session.browser ?? "Unknown";
  const os = session.os ?? "Unknown";

  return (
    <TableRow index={index}>
      <TableCell>
        <Tooltip content={formatAbsoluteTime(session.started_at)}>
          <Link className="font-medium text-foreground hover:underline" to={href}>
            {formatRelativeTime(session.started_at)}
          </Link>
        </Tooltip>
      </TableCell>
      <TableCell>{formatDuration(session.duration_ms)}</TableCell>
      <TableCell>
        <span className="block max-w-[260px] truncate">{session.entry_url ?? "/"}</span>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          <Badge color="blue" size="sm" variant="dot">
            {session.clicks} clicks
          </Badge>
          <Badge color={session.errors > 0 ? "red" : "gray"} size="sm" variant="dot">
            {session.errors} errors
          </Badge>
          <Badge color={session.rages > 0 ? "orange" : "gray"} size="sm" variant="dot">
            {session.rages} rages
          </Badge>
        </div>
      </TableCell>
      <TableCell>{country}</TableCell>
      <TableCell>{browser}</TableCell>
      <TableCell>{os}</TableCell>
      <TableCell>{formatBytes(session.bytes)}</TableCell>
    </TableRow>
  );
}

function LoadingRows() {
  return Array.from({ length: 5 }, (_, index) => (
    <TableRow index={index} key={index}>
      {Array.from({ length: 8 }, (_unused, cellIndex) => (
        <TableCell key={cellIndex}>
          <Skeleton className="h-5 w-full" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

function SessionsEmptyState() {
  return (
    <Empty className="border border-border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No sessions yet</EmptyTitle>
        <EmptyDescription>
          Seed a project through the guarded test surface with DEV_TEST_ROUTES=1.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <code className="w-full rounded-lg bg-muted px-3 py-2 text-left text-xs text-muted-foreground">
          curl -X POST http://localhost:8787/__test/ingest/seed
        </code>
      </EmptyContent>
    </Empty>
  );
}

function PageHeader({ description, title }: { description: string; title: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-normal">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
