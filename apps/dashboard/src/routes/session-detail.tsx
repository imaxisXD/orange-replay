import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { AlertCircle, ArrowLeft, Play } from "lucide-react";
import type { SessionManifest } from "@orange-replay/shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, getManifest, segmentUrl } from "@/lib/api";
import { formatAbsoluteTime, formatBytes, formatDuration } from "@/lib/format";
import { defaultProjectId } from "@/router";

export function SessionDetailPage() {
  const params = useParams();
  const projectId = params.projectId ?? defaultProjectId;
  const sessionId = params.sessionId;
  const [manifest, setManifest] = useState<SessionManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadManifest = useCallback(async () => {
    if (sessionId === undefined) return;

    setLoading(true);
    setError("");

    try {
      setManifest(await getManifest(projectId, sessionId));
    } catch (caughtError) {
      setManifest(null);
      setError(readErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void loadManifest();
  }, [loadManifest]);

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
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Button asChild leadingIcon={ArrowLeft} size="sm" variant="ghost">
            <Link to={`/projects/${projectId}/sessions`}>Sessions</Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-normal">Session {sessionId}</h1>
        </div>
        <Button leadingIcon={Play} onClick={() => void loadManifest()} variant="tertiary">
          Refresh manifest
        </Button>
      </div>

      {error.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load manifest</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? <DetailLoading /> : manifest !== null && <ManifestHeader manifest={manifest} />}

      <section className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card p-8 text-center shadow-surface-1">
        <Play aria-hidden className="size-8 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-normal">Player placeholder</h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            T3.3 adds the player package. T3.5 fills this route with playback controls, timeline
            events, and jump-to-click or jump-to-error actions.
          </p>
        </div>
        {manifest?.segments[0] !== undefined && (
          <Tooltip
            content={segmentUrl(projectId, sessionId, firstSegmentName(manifest.segments[0].key))}
          >
            <Badge color="gray" variant="dot">
              First segment ready
            </Badge>
          </Tooltip>
        )}
      </section>
    </div>
  );
}

function ManifestHeader({ manifest }: { manifest: SessionManifest }) {
  const attrs = manifest.attrs;

  return (
    <section className="grid gap-4 rounded-lg border border-border bg-card p-5 shadow-surface-1 lg:grid-cols-4">
      <Metric label="Duration" value={formatDuration(manifest.durationMs)} />
      <Metric label="Started" value={formatAbsoluteTime(manifest.startedAt)} />
      <Metric label="Bytes" value={formatBytes(manifest.bytes)} />
      <Metric label="Segments" value={String(manifest.segments.length)} />

      <div className="flex flex-wrap gap-2 lg:col-span-4">
        <Badge color="blue" variant="dot">
          {manifest.counts.clicks} clicks
        </Badge>
        <Badge color={manifest.counts.errors > 0 ? "red" : "gray"} variant="dot">
          {manifest.counts.errors} errors
        </Badge>
        <Badge color={manifest.counts.rages > 0 ? "orange" : "gray"} variant="dot">
          {manifest.counts.rages} rages
        </Badge>
        <Badge color="gray" variant="dot">
          {attrs.country ?? "Unknown country"}
        </Badge>
        <Badge color="gray" variant="dot">
          {attrs.browser ?? "Unknown browser"}
        </Badge>
        <Badge color="gray" variant="dot">
          {attrs.os ?? "Unknown OS"}
        </Badge>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

function DetailLoading() {
  return (
    <section className="grid gap-4 rounded-lg border border-border bg-card p-5 shadow-surface-1 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_unused, index) => (
        <div className="flex flex-col gap-2" key={index}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-5 w-32" />
        </div>
      ))}
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
