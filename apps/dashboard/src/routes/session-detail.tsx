import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CountryFlag } from "@/components/country-flag";
import { IconSwap } from "@/components/ui/icon-swap";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { formatCountryCode } from "@/lib/country";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { formatBytes, formatDuration, formatErrorCount } from "@/lib/format";
import { AlertCircle, ArrowLeft, Check, Copy, RotateCcw } from "@/lib/icon-map";
import { ReplayWorkspace } from "./session-detail/replay-playback";
import { loadSessionManifest } from "./session-detail/session-detail-data";

export function SessionDetailPage() {
  const { projectId, isDemo } = useDashboardWorkspace();
  const params = useParams({ strict: false });
  const sessionId = params.sessionId;
  const manifestQuery = useQuery({
    enabled: sessionId !== undefined,
    queryKey: ["session-manifest", isDemo ? "demo" : "private", projectId, sessionId],
    queryFn: ({ signal }) => loadSessionManifest(projectId, sessionId ?? "", signal),
  });
  const manifest = manifestQuery.data?.manifest ?? null;
  const mode = manifestQuery.data?.mode ?? "recorded";
  const loading = manifestQuery.isPending;
  const error = manifestQuery.error === null ? "" : readErrorMessage(manifestQuery.error);
  const notFound = manifestQuery.data?.notFound ?? false;

  if (sessionId === undefined) {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden />
        <AlertTitle>Missing session id</AlertTitle>
        <AlertDescription>The route does not include a session id.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <BackToSessionsButton isDemo={isDemo} projectId={projectId} />
        <Button
          leadingIcon={RotateCcw}
          onClick={() => void manifestQuery.refetch()}
          size="sm"
          variant="ghost"
        >
          Refresh manifest
        </Button>
      </div>

      <SessionIdHeader sessionId={sessionId} />

      {error.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load manifest</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {notFound && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Session not found</AlertTitle>
          <AlertDescription>This session is not available.</AlertDescription>
        </Alert>
      )}

      {loading ? <DetailLoading /> : manifest !== null && <ManifestHeader manifest={manifest} />}

      {!loading && manifest !== null && (
        <ReplayWorkspace
          isDemo={isDemo}
          manifest={manifest}
          mode={mode}
          projectId={projectId}
          sessionId={sessionId}
        />
      )}

      {manifest !== null && manifest.segments.length > 0 && (
        <SegmentTable segments={manifest.segments} />
      )}
    </div>
  );
}

function SessionIdHeader({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copySessionId(): Promise<void> {
    await navigator.clipboard.writeText(sessionId);
    setCopied(true);
  }

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-[18px] font-semibold tracking-[-0.015em]">Session</h1>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[13px] text-muted-foreground">{sessionId}</span>
        <Tooltip content="Copy session id">
          <Button
            aria-label="Copy session id"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void copySessionId()}
            size="icon-sm"
            variant="ghost"
          >
            <IconSwap swapKey={copied ? "check" : "copy"}>
              {copied ? (
                <Check aria-hidden className="size-4 text-success" />
              ) : (
                <Copy aria-hidden className="size-4" />
              )}
            </IconSwap>
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

function BackToSessionsButton({ isDemo, projectId }: { isDemo: boolean; projectId: string }) {
  if (isDemo) {
    return (
      <Button asChild leadingIcon={ArrowLeft} size="sm" variant="ghost">
        <Link to="/demo/sessions">Sessions</Link>
      </Button>
    );
  }

  return (
    <Button asChild leadingIcon={ArrowLeft} size="sm" variant="ghost">
      <Link params={{ projectId }} to="/projects/$projectId/sessions">
        Sessions
      </Link>
    </Button>
  );
}

function ManifestHeader({ manifest }: { manifest: SessionManifest }) {
  const attrs = manifest.attrs;
  const errors = manifest.counts.errors;
  const rageClicks = manifest.counts.rages;

  return (
    <section className="lit overflow-hidden rounded-lg">
      <div className="flex overflow-x-auto">
        <Metric label="Duration" value={formatDuration(manifest.durationMs)} />
        <Metric label="Events" value={String(manifest.counts.events)} />
        <Metric label="Errors" value={String(errors)} warm={errors > 0} />
        <Metric label="Rage clicks" value={String(rageClicks)} warm={rageClicks > 0} />
      </div>

      <div className="flex flex-wrap gap-2 px-4.5 pb-3.75">
        {errors > 0 && (
          <Badge color="red" size="sm" variant="dot">
            {formatErrorCount(errors)}
          </Badge>
        )}
        {rageClicks > 0 && (
          <Badge color="amber" size="sm" variant="dot">
            {rageClicks} rage
          </Badge>
        )}
        <Badge color="gray" size="sm">
          <span className="inline-flex items-center gap-1.5">
            <CountryFlag country={attrs.country} />
            {formatCountryCode(attrs.country)}
          </span>
        </Badge>
        <Badge color="gray" size="sm">
          {attrs.browser ?? "Unknown"}
          <span className="px-1 text-dim">·</span>
          {attrs.os ?? "Unknown"}
        </Badge>
      </div>
    </section>
  );
}

function Metric({ label, value, warm = false }: { label: string; value: string; warm?: boolean }) {
  return (
    <div className="min-w-45 flex-1 border-r border-dashed border-dash px-4.5 py-3.75 last:border-r-0">
      <div className="mb-1.5 text-[11.5px] text-muted-foreground">{label}</div>
      <div
        className={
          warm
            ? "font-mono text-[21px] font-semibold tracking-[-0.02em] text-amber"
            : "font-mono text-[21px] font-semibold tracking-[-0.02em] text-foreground"
        }
      >
        {value}
      </div>
    </div>
  );
}

function DetailLoading() {
  return (
    <section className="lit overflow-hidden rounded-lg">
      <div className="flex overflow-x-auto">
        {Array.from({ length: 4 }, (_unused, index) => (
          <div
            className="min-w-45 flex-1 border-r border-dashed border-dash px-4.5 py-3.75 last:border-r-0"
            key={index}
          >
            <Skeleton className="mb-1.5 h-3 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>
      <div className="flex gap-2 px-4.5 pb-3.75">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-6 w-28 rounded-full" />
      </div>
    </section>
  );
}

function SegmentTable({ segments }: { segments: SegmentRef[] }) {
  return (
    <section className="lit overflow-hidden rounded-lg">
      <div className="border-b border-dashed border-dash px-4 py-3">
        <h2 className="text-[15px] font-medium">Segments</h2>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Segment</TableHead>
              <TableHead className="text-right">Time</TableHead>
              <TableHead className="text-right">Batches</TableHead>
              <TableHead className="text-right">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {segments.map((segment, index) => (
              <TableRow index={index} key={segment.key}>
                <TableCell className="font-mono text-[12px] text-muted-foreground">
                  {firstSegmentName(segment.key)}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] text-foreground">
                  {formatDuration(segment.t1 - segment.t0)}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
                  {segment.batches}
                </TableCell>
                <TableCell className="text-right font-mono text-[12px] text-muted-foreground">
                  {formatBytes(segment.bytes)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function firstSegmentName(key: string): string {
  return key.split("/").at(-1) ?? key;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
