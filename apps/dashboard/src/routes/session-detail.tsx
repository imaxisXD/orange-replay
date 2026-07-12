import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { applyLiveIndexToSnapshot } from "@orange-replay/player";
import type { BatchIndex, LiveSessionSnapshot, SessionManifest } from "@orange-replay/shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ClientLabel } from "@/components/client-label";
import { CountryFlag } from "@/components/country-flag";
import { IconSwap } from "@/components/ui/icon-swap";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { formatCountryCode } from "@/lib/country";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { formatAbsoluteTime, formatDuration, formatShortRelativeTime } from "@/lib/format";
import {
  AlertCircle,
  Angry,
  ArrowLeft,
  Check,
  Copy,
  RotateCcw,
  Smartphone,
  type IconComponent,
} from "@/lib/icon-map";
import { ReplayWorkspace } from "./session-detail/replay-playback";
import { loadSessionManifest } from "./session-detail/session-detail-data";
import { entryPath } from "./sessions/session-card";

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
  const refetchManifest = manifestQuery.refetch;
  const mode = manifestQuery.data?.mode ?? "recorded";
  const loading = manifestQuery.isPending;
  const error = manifestQuery.error === null ? "" : readErrorMessage(manifestQuery.error);
  const notFound = manifestQuery.data?.notFound ?? false;
  const [deadClickCount, setDeadClickCount] = useState(0);
  const [liveState, setLiveState] = useState<{
    sessionId: string;
    snapshot: LiveSessionSnapshot;
  } | null>(null);
  const currentSessionId = sessionId ?? "";
  const liveSnapshot =
    mode === "live" && liveState !== null && liveState.sessionId === currentSessionId
      ? liveState.snapshot
      : null;

  const displayedManifest = useMemo(
    () => mergeLiveSnapshot(manifest, liveSnapshot),
    [liveSnapshot, manifest],
  );

  const handleLiveIndex = useCallback((index: BatchIndex) => {
    setLiveState((current) =>
      current === null || current.sessionId !== index.s
        ? current
        : { ...current, snapshot: applyLiveIndexToSnapshot(current.snapshot, index) },
    );
  }, []);
  const handleLiveSnapshot = useCallback(
    (snapshot: LiveSessionSnapshot) => setLiveState({ sessionId: currentSessionId, snapshot }),
    [currentSessionId],
  );
  const handleLiveEnded = useCallback(() => {
    void refetchManifest();
  }, [refetchManifest]);

  useEffect(() => {
    setDeadClickCount(0);
  }, [sessionId]);

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
          onClick={() => void refetchManifest()}
          size="sm"
          variant="ghost"
        >
          Reload session
        </Button>
      </div>

      <SessionHeader manifest={displayedManifest} sessionId={sessionId} />

      {error.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load this session</AlertTitle>
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

      {loading ? (
        <DetailLoading />
      ) : (
        displayedManifest !== null && (
          <ManifestHeader deadClickCount={deadClickCount} manifest={displayedManifest} />
        )
      )}

      {!loading && manifest !== null && displayedManifest !== null && (
        <ReplayWorkspace
          isDemo={isDemo}
          manifest={displayedManifest}
          mode={mode}
          onDeadClickCountChange={setDeadClickCount}
          onLiveEnded={handleLiveEnded}
          onLiveIndex={handleLiveIndex}
          onLiveSnapshot={handleLiveSnapshot}
          playerManifest={manifest}
          projectId={projectId}
          sessionId={sessionId}
        />
      )}
    </div>
  );
}

function mergeLiveSnapshot(
  manifest: SessionManifest | null,
  snapshot: LiveSessionSnapshot | null,
): SessionManifest | null {
  if (manifest === null || snapshot === null) return manifest;
  return {
    ...manifest,
    endedAt: snapshot.endedAt,
    durationMs: snapshot.durationMs,
    timeline: snapshot.timeline,
    counts: snapshot.counts,
  };
}

function SessionHeader({
  manifest,
  sessionId,
}: {
  manifest: SessionManifest | null;
  sessionId: string;
}) {
  // While the manifest loads (or fails), the id is the only identity we have.
  if (manifest === null) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">Session</h1>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] text-muted-foreground">{sessionId}</span>
          <CopySessionId sessionId={sessionId} />
        </div>
      </div>
    );
  }

  const attrs = manifest.attrs;
  const hasClient = Boolean(attrs.browser) || Boolean(attrs.os);
  const isHandheld = attrs.device === "mobile" || attrs.device === "tablet";

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {/* The page a human recognizes leads; the machine id is a chip. */}
        <h1 className="truncate text-[18px] font-semibold tracking-[-0.015em]">
          {entryPath(attrs.entryUrl ?? null)}
        </h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <CountryFlag country={attrs.country} />
          <span>{formatCountryCode(attrs.country)}</span>
          {hasClient && (
            <>
              <span className="text-dim">·</span>
              <ClientLabel browser={attrs.browser ?? null} os={attrs.os ?? null} />
            </>
          )}
          {isHandheld && (
            <Smartphone aria-label="Mobile device" className="size-3 text-muted-foreground" />
          )}
          <span className="text-dim">·</span>
          <span title={formatAbsoluteTime(manifest.startedAt)}>
            {startedCopy(manifest.startedAt)}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary py-0.5 pr-0.5 pl-2.5">
        <span className="font-mono text-[11px] text-muted-foreground" title={sessionId}>
          {sessionId.slice(0, 13)}…
        </span>
        <CopySessionId sessionId={sessionId} />
      </div>
    </div>
  );
}

function startedCopy(startedAt: number): string {
  const label = formatShortRelativeTime(startedAt);
  return label === "now" ? "started just now" : `started ${label} ago`;
}

function CopySessionId({ sessionId }: { sessionId: string }) {
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
            <Check aria-hidden className="size-3.5 text-success" />
          ) : (
            <Copy aria-hidden className="size-3.5" />
          )}
        </IconSwap>
      </Button>
    </Tooltip>
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

function ManifestHeader({
  deadClickCount,
  manifest,
}: {
  deadClickCount: number;
  manifest: SessionManifest;
}) {
  const errors = manifest.counts.errors;
  const rageClicks = manifest.counts.rages;
  const pageCount = manifest.attrs.pageCount;

  // Every number appears exactly once: warm tiles ARE the frustration signal,
  // so no pill row repeats them, and context lives in the page header.
  return (
    <section className="lit overflow-hidden rounded-lg">
      <ScrollArea orientation="horizontal" viewportClassName="scroll-fade-x">
        <div className="flex min-w-full w-max">
          <Metric label="Duration" value={formatDuration(manifest.durationMs)} />
          {pageCount !== undefined && <Metric label="Pages" value={String(pageCount)} />}
          <Metric label="Events" value={String(manifest.counts.events)} />
          <Metric icon={AlertCircle} label="Errors" value={String(errors)} warm={errors > 0} />
          <Metric
            icon={Angry}
            label="Rage clicks"
            value={String(rageClicks)}
            warm={rageClicks > 0}
          />
          {deadClickCount > 0 && <Metric label="Dead clicks" value={String(deadClickCount)} warm />}
        </div>
      </ScrollArea>
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  warm = false,
}: {
  icon?: IconComponent;
  label: string;
  value: string;
  warm?: boolean;
}) {
  return (
    <div className="min-w-45 flex-1 border-r border-dashed border-dash px-4.5 py-3.75 last:border-r-0">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        {Icon !== undefined && (
          <Icon aria-hidden className={warm ? "size-3 text-amber" : "size-3 text-dim"} />
        )}
        {label}
      </div>
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
      <ScrollArea orientation="horizontal" viewportClassName="scroll-fade-x">
        <div className="flex min-w-full w-max">
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
      </ScrollArea>
      <div className="flex gap-2 px-4.5 pb-3.75">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-6 w-28 rounded-full" />
      </div>
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The request failed. Try again in a moment.";
}
