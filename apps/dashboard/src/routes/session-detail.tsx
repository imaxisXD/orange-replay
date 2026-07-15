import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import type { SessionManifest } from "@orange-replay/shared/types";
import { AnimatedDuration, AnimatedNumber } from "@/components/animated-number";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ClientLabel } from "@/components/client-label";
import { CountryFlag } from "@/components/country-flag";
import { IconSwap } from "@/components/ui/icon-swap";
import { LoadingArea } from "@/components/ui/loading-indicator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusPill } from "@/components/status-pill";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, type SessionActivity, type SessionDetailsState } from "@/lib/api";
import { formatCountryCode } from "@/lib/country";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { entryPath } from "@/lib/entry-path";
import { formatAbsoluteTime, formatShortRelativeTime } from "@/lib/format";
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
import { useSessionView } from "./session-detail/use-session-view";

export function SessionDetailPage() {
  const { projectId, isDemo } = useDashboardWorkspace();
  const params = useParams({ strict: false });
  const sessionId = params.sessionId;
  const sessionView = useSessionView({
    isDemo,
    projectId,
    sessionId: sessionId ?? "",
  });
  const manifest = sessionView.displayedManifest;
  const playerManifest = sessionView.playerManifest;
  const error = sessionView.error === null ? "" : readErrorMessage(sessionView.error);
  const [deadClickState, setDeadClickState] = useState({ count: 0, sessionId });
  const deadClickCount = deadClickState.sessionId === sessionId ? deadClickState.count : 0;

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
        <Button leadingIcon={RotateCcw} onClick={sessionView.refresh} size="sm" variant="ghost">
          Reload session
        </Button>
      </div>

      <SessionHeader manifest={manifest} sessionId={sessionId} />

      {error.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load this session</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {sessionView.notFound && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Session not found</AlertTitle>
          <AlertDescription>This session is not available.</AlertDescription>
        </Alert>
      )}

      {sessionView.loading ? (
        <DetailLoading />
      ) : (
        manifest !== null && (
          <ManifestHeader
            activity={sessionView.activity}
            deadClickCount={deadClickCount}
            detailsState={sessionView.detailsState}
            manifest={manifest}
          />
        )
      )}

      {!sessionView.loading && manifest !== null && playerManifest !== null && (
        <ReplayWorkspace
          isDemo={isDemo}
          manifest={manifest}
          mode={sessionView.mode}
          onDeadClickCountChange={(count) => setDeadClickState({ count, sessionId })}
          onLiveEnded={sessionView.onLiveEnded}
          onLiveFinalized={sessionView.onLiveFinalized}
          onLiveIndex={sessionView.onLiveIndex}
          onLiveSnapshot={sessionView.onLiveSnapshot}
          playerManifest={playerManifest}
          projectId={projectId}
          reviewLiveHistory={sessionView.activity === "idle"}
          sessionId={sessionId}
        />
      )}
    </div>
  );
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
        <h1 className="text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]">Session</h1>
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
        <h1
          className="truncate text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]"
          title={entryPath(attrs.entryUrl ?? null)}
        >
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
  activity,
  deadClickCount,
  detailsState,
  manifest,
}: {
  activity: SessionActivity | null;
  deadClickCount: number;
  detailsState: SessionDetailsState | null;
  manifest: SessionManifest;
}) {
  const errors = manifest.counts.errors;
  const rageClicks = manifest.counts.rages;
  const pageCount = manifest.attrs.pageCount;
  const animateMetrics = activity !== "live";

  // Every number appears exactly once: warm tiles ARE the frustration signal,
  // so no pill row repeats them, and context lives in the page header.
  return (
    <section className="lit overflow-hidden rounded-lg">
      {activity === "live" ? (
        <div className="border-b border-dashed border-dash px-4.5 py-2.5">
          <StatusPill kind="ok">Live</StatusPill>
        </div>
      ) : detailsState === "provisional" ? (
        <div className="border-b border-dashed border-dash px-4.5 py-2.5">
          <StatusPill kind="neutral">Final details pending</StatusPill>
        </div>
      ) : null}
      <ScrollArea orientation="horizontal" viewportClassName="scroll-fade-x">
        <div className="flex min-w-full w-max">
          <Metric
            label="Duration"
            value={
              <AnimatedDuration
                animated={animateMetrics}
                startFromZero
                value={manifest.durationMs}
              />
            }
          />
          {detailsState === "exact" && pageCount !== undefined && (
            <Metric
              label="Pages"
              value={<AnimatedNumber animated={animateMetrics} startFromZero value={pageCount} />}
            />
          )}
          {detailsState === "exact" && (
            <>
              <Metric
                label="Events"
                value={
                  <AnimatedNumber
                    animated={animateMetrics}
                    startFromZero
                    value={manifest.counts.events}
                  />
                }
              />
              <Metric
                icon={AlertCircle}
                label="Errors"
                value={<AnimatedNumber animated={animateMetrics} startFromZero value={errors} />}
                warm={errors > 0}
              />
              <Metric
                icon={Angry}
                label="Rage clicks"
                value={
                  <AnimatedNumber animated={animateMetrics} startFromZero value={rageClicks} />
                }
                warm={rageClicks > 0}
              />
            </>
          )}
          {deadClickCount > 0 && (
            <Metric
              label="Dead clicks"
              value={
                <AnimatedNumber animated={animateMetrics} startFromZero value={deadClickCount} />
              }
              warm
            />
          )}
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
  value: ReactNode;
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
          warm ? "font-numeric text-[21px] text-amber" : "font-numeric text-[21px] text-foreground"
        }
      >
        {value}
      </div>
    </div>
  );
}

function DetailLoading() {
  return <LoadingArea className="lit min-h-28 rounded-lg" label="Loading session details" />;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The request failed. Try again in a moment.";
}
