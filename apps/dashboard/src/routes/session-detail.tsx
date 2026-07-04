import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { AlertCircle, ArrowLeft, Check, Copy, PlayCircle, RotateCcw } from "lucide-react";
import type { SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import { StatusPill } from "@/components/status-pill";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { ApiError, getManifest } from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/format";
import { defaultProjectId } from "@/router";

export function SessionDetailPage() {
  const params = useParams();
  const projectId = params.projectId ?? defaultProjectId;
  const sessionId = params.sessionId;
  const [manifest, setManifest] = useState<SessionManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

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

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copySessionId(): Promise<void> {
    if (sessionId === undefined) return;
    await navigator.clipboard.writeText(sessionId);
    setCopied(true);
  }

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
        <Button asChild leadingIcon={ArrowLeft} size="sm" variant="ghost">
          <Link to={`/projects/${projectId}/sessions`}>Sessions</Link>
        </Button>
        <Button
          leadingIcon={RotateCcw}
          onClick={() => void loadManifest()}
          size="sm"
          variant="ghost"
        >
          Refresh manifest
        </Button>
      </div>

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
              {copied ? (
                <Check aria-hidden className="size-4 text-success" />
              ) : (
                <Copy aria-hidden className="size-4" />
              )}
            </Button>
          </Tooltip>
        </div>
      </div>

      {error.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertTitle>Could not load manifest</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? <DetailLoading /> : manifest !== null && <ManifestHeader manifest={manifest} />}

      <section className="lit flex h-[360px] flex-col items-center justify-center gap-2 overflow-hidden rounded-lg text-center">
        <PlayCircle aria-hidden className="size-10 text-dim" />
        <h2 className="text-[15px] font-medium">Replay player coming soon</h2>
        <p className="text-[13px] text-muted-foreground">
          This session&apos;s recording is stored and indexed — playback is on the way.
        </p>
      </section>

      {manifest !== null && manifest.segments.length > 0 && (
        <SegmentTable segments={manifest.segments} />
      )}
    </div>
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

      <div className="flex flex-wrap gap-2 px-[18px] pb-[15px]">
        {errors > 0 && <StatusPill kind="err">{errors} errors</StatusPill>}
        {rageClicks > 0 && <StatusPill kind="rage">{rageClicks} rage</StatusPill>}
        <StatusPill kind="neutral">{formatCountry(attrs.country)}</StatusPill>
        <StatusPill kind="neutral">
          {attrs.browser ?? "Unknown"}
          <span className="px-1 text-dim">·</span>
          {attrs.os ?? "Unknown"}
        </StatusPill>
      </div>
    </section>
  );
}

function Metric({ label, value, warm = false }: { label: string; value: string; warm?: boolean }) {
  return (
    <div className="min-w-[180px] flex-1 border-r border-dashed border-dash px-[18px] py-[15px] last:border-r-0">
      <div className="mb-[6px] text-[11.5px] text-muted-foreground">{label}</div>
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
            className="min-w-[180px] flex-1 border-r border-dashed border-dash px-[18px] py-[15px] last:border-r-0"
            key={index}
          >
            <Skeleton className="mb-[6px] h-3 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>
      <div className="flex gap-2 px-[18px] pb-[15px]">
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

function formatCountry(country: string | undefined): string {
  if (country === undefined || country.trim().length === 0) return "Unknown";
  const code = country.trim().toUpperCase();
  return `${flagForCountry(code)} ${code}`;
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
