import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { Check, Copy, RotateCcw } from "lucide-react";
import { buildLoaderSnippet } from "@orange-replay/sdk/loader";
import { StatusPill } from "@/components/status-pill";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, fetchInstallStatus } from "@/lib/api";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import { installStatusPollIntervalMs, shouldPollInstallStatus } from "@/lib/project-settings";
import { defaultProjectId } from "@/router";

export function InstallPage() {
  const params = useParams();
  const projectId = params.projectId ?? defaultProjectId;
  const snippet = useMemo(
    () =>
      buildLoaderSnippet({
        bundleUrl: "https://YOUR_HOST/or-recorder.js",
        init: { key: "YOUR_WRITE_KEY", ingestUrl: "https://YOUR_HOST" },
      }),
    [],
  );
  const [firstEventAt, setFirstEventAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const loadInstallStatus = useCallback(
    async (showLoading = false) => {
      if (showLoading) setLoading(true);
      setError("");

      try {
        const response = await fetchInstallStatus(projectId);
        setFirstEventAt(response.firstEventAt);
      } catch (caughtError) {
        setError(readErrorMessage(caughtError));
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    let intervalId: number | undefined;

    function stopPolling(): void {
      if (intervalId === undefined) return;
      window.clearInterval(intervalId);
      intervalId = undefined;
    }

    function startPolling(): void {
      stopPolling();
      if (!shouldPollInstallStatus(document.visibilityState)) return;

      intervalId = window.setInterval(() => {
        if (shouldPollInstallStatus(document.visibilityState)) {
          void loadInstallStatus();
        }
      }, installStatusPollIntervalMs);
    }

    function handleVisibilityChange(): void {
      if (!shouldPollInstallStatus(document.visibilityState)) {
        stopPolling();
        return;
      }

      void loadInstallStatus();
      startPolling();
    }

    void loadInstallStatus(true);
    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadInstallStatus]);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  async function copySnippet(): Promise<void> {
    try {
      await window.navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch (caughtError) {
      setError(readErrorMessage(caughtError));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Install
          <span className="ml-[10px] text-[12px] font-normal text-dim">
            Add the snippet and verify events arrive.
          </span>
        </h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <section className="lit rounded-lg p-5">
          <h2 className="text-[15px] font-medium">Loader snippet</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Paste before <code className="font-mono text-foreground">&lt;/head&gt;</code>. The
            loader is under 2 KB and defers everything else.
          </p>

          <div className="relative mt-4 rounded-lg border border-border bg-secondary p-4 pr-12">
            <Tooltip content={copied ? "Copied" : "Copy snippet"}>
              <Button
                aria-label="Copy snippet"
                className="absolute right-3 top-3 text-dim hover:text-foreground"
                onClick={() => void copySnippet()}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              </Button>
            </Tooltip>
            <pre className="max-h-[420px] overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted-foreground">
              {snippet}
            </pre>
          </div>
        </section>

        <section className="lit rounded-lg p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-medium">Live verify</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">Checks for the first event.</p>
            </div>
            <span className="text-[11.5px] text-dim">every 3s</span>
          </div>

          {error.length > 0 && (
            <Alert className="mt-4" variant="destructive">
              <RotateCcw aria-hidden />
              <AlertTitle>Could not check install status</AlertTitle>
              <AlertDescription>
                <p>{error}</p>
                <Button
                  className="mt-2 border-[rgba(244,83,78,0.35)] bg-transparent text-[#ffb3b0] hover:text-foreground"
                  leadingIcon={RotateCcw}
                  onClick={() => void loadInstallStatus(true)}
                  size="sm"
                  variant="secondary"
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {firstEventAt === null ? (
            <div className="mt-5 flex items-start gap-3">
              <span
                aria-hidden
                className="mt-[5px] size-[7px] rounded-full bg-amber opacity-80 animate-pulse"
              />
              <div>
                <div className="text-[13px]">
                  {loading ? "Checking install status..." : "Waiting for the first event…"}
                </div>
                <div className="mt-1 text-[11.5px] text-dim">
                  Open a page with the snippet installed — this updates the moment data arrives.
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex flex-col items-start gap-3">
              <StatusPill kind="ok">Installed</StatusPill>
              <div className="text-[13px]" title={formatAbsoluteTime(firstEventAt)}>
                First event seen {formatRelativeTime(firstEventAt)}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
