import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertCircle, Check, Code2, Copy, RotateCcw } from "lucide-react";
import { buildLoaderScriptTag } from "@orange-replay/sdk/loader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, fetchInstallStatus, fetchProjectKeys } from "@/lib/api";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import { installStatusPollIntervalMs, shouldPollInstallStatus } from "@/lib/project-settings";
import { defaultProjectId } from "@/lib/routes";

export function InstallPage() {
  const params = useParams({ strict: false });
  const projectId = params.projectId ?? defaultProjectId;
  const defaultOrigin = useMemo(readDefaultOrigin, []);
  const [writeKeyInput, setWriteKeyInput] = useState("");
  const [originInput, setOriginInput] = useState(defaultOrigin);
  const [copied, setCopied] = useState(false);
  const [showFullCode, setShowFullCode] = useState(false);
  const [copyError, setCopyError] = useState("");
  const normalizedOrigin = normalizeOrigin(originInput);
  const cleanWriteKey = writeKeyInput.trim();
  const keysQuery = useQuery({
    queryKey: ["project-keys", projectId],
    queryFn: () => fetchProjectKeys(projectId),
  });
  const installStatusQuery = useQuery({
    queryKey: ["install-status", projectId],
    queryFn: () => fetchInstallStatus(projectId),
    refetchInterval: (query) => {
      if (query.state.data?.firstEventAt !== null && query.state.data !== undefined) return false;
      return shouldPollInstallStatus(document.visibilityState)
        ? installStatusPollIntervalMs
        : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const hasActiveWriteKey = keysQuery.data?.keys.some((key) => key.active) ?? false;
  const originError =
    originInput.trim().length === 0
      ? "Enter your Orange Replay URL."
      : normalizedOrigin === null
        ? "Use a valid http or https URL."
        : "";
  const writeKeyReady = isGeneratedWriteKey(cleanWriteKey);
  const keyInputError =
    cleanWriteKey.length === 0
      ? "Paste the raw write key before copying."
      : writeKeyReady
        ? ""
        : "Use a generated write key that starts with or_live_.";
  const canCopySnippet =
    writeKeyReady && normalizedOrigin !== null && hasActiveWriteKey && !keysQuery.isPending;
  const snippet = useMemo(() => {
    if (!canCopySnippet || normalizedOrigin === null) return "";
    return buildLoaderScriptTag({
      bundleUrl: `${normalizedOrigin}/or-recorder.js`,
      init: { key: cleanWriteKey, ingestUrl: normalizedOrigin },
    });
  }, [canCopySnippet, cleanWriteKey, normalizedOrigin]);
  const shownSnippet =
    snippet.length === 0 ? blockedSnippetPreview : showFullCode ? snippet : shortSnippetPreview;
  const firstEventAt = installStatusQuery.data?.firstEventAt ?? null;
  const loading = installStatusQuery.isPending;
  const queryError =
    installStatusQuery.error === null ? "" : readErrorMessage(installStatusQuery.error);
  const keysError = keysQuery.error === null ? "" : readErrorMessage(keysQuery.error);
  const snippetError = copyError || keysError;
  const verifyError = queryError;
  const copyBlockedReason = readCopyBlockedReason({
    cleanWriteKey,
    hasActiveWriteKey,
    keysLoading: keysQuery.isPending,
    normalizedOrigin,
    originInput,
    writeKeyReady,
  });
  const copyButtonLabel = copied ? "Copied" : (copyBlockedReason ?? "Copy snippet");

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  async function copySnippet(): Promise<void> {
    if (!canCopySnippet) {
      setCopyError(copyBlockedReason ?? "The snippet is not ready yet.");
      return;
    }

    try {
      await window.navigator.clipboard.writeText(snippet);
      setCopyError("");
      setCopied(true);
    } catch (caughtError) {
      setCopyError(readErrorMessage(caughtError));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Install
          <span className="ml-2.5 text-[12px] font-normal text-dim">
            Add the snippet and verify events arrive.
          </span>
        </h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <section className="lit rounded-lg p-5">
          <h2 className="text-[15px] font-medium">Loader snippet</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Paste before <code className="font-mono text-foreground">&lt;/head&gt;</code>. Raw keys
            are shown only where you created them.
          </p>

          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <InputGroup className="w-full gap-0">
              <InputField
                autoComplete="off"
                error={keyInputError.length > 0 && writeKeyInput.length > 0 ? keyInputError : ""}
                index={0}
                label="Write key"
                onChange={(value) => {
                  setWriteKeyInput(value);
                  setCopied(false);
                  setCopyError("");
                }}
                placeholder="Paste the raw key"
                type="password"
                value={writeKeyInput}
              />
            </InputGroup>
            <InputGroup className="w-full gap-0">
              <InputField
                error={originError.length > 0 ? originError : ""}
                index={0}
                inputMode="url"
                label="Orange Replay URL"
                onChange={(value) => {
                  setOriginInput(value);
                  setCopied(false);
                  setCopyError("");
                }}
                placeholder="https://replay.example.com"
                value={originInput}
              />
            </InputGroup>
          </div>

          {snippetError.length > 0 && (
            <Alert className="mt-4" variant={keysError.length > 0 ? "destructive" : "default"}>
              <AlertCircle aria-hidden />
              <AlertTitle>
                {keysError.length > 0 ? "Could not load write keys" : "Snippet not ready"}
              </AlertTitle>
              <AlertDescription>
                <p>{snippetError}</p>
                {keysError.length > 0 && (
                  <Button
                    className="mt-2 border-danger-border bg-transparent text-danger-foreground hover:text-foreground"
                    leadingIcon={RotateCcw}
                    onClick={() => void keysQuery.refetch()}
                    size="sm"
                    variant="secondary"
                  >
                    Retry
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {!keysQuery.isPending &&
            !hasActiveWriteKey &&
            keysError.length === 0 &&
            copyError.length === 0 && (
              <Alert className="mt-4">
                <AlertCircle aria-hidden />
                <AlertTitle>No active write key</AlertTitle>
                <AlertDescription>
                  Create a project write key in Settings, then paste the raw key here.
                </AlertDescription>
              </Alert>
            )}

          <div className="relative mt-4 rounded-lg border border-border bg-secondary p-4 pr-12">
            <Tooltip content={copyButtonLabel}>
              <Button
                aria-label="Copy full snippet"
                className="absolute right-3 top-3 text-dim hover:text-foreground"
                disabled={!canCopySnippet}
                onClick={() => void copySnippet()}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <IconSwap swapKey={copied ? "check" : "copy"}>
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                </IconSwap>
              </Button>
            </Tooltip>
            <pre
              className={`overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted-foreground ${
                showFullCode ? "max-h-105" : "max-h-24"
              }`}
            >
              {shownSnippet}
            </pre>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              active={showFullCode}
              aria-expanded={showFullCode}
              leadingIcon={Code2}
              onClick={() => setShowFullCode((isShowing) => !isShowing)}
              size="sm"
              type="button"
              variant="secondary"
            >
              {showFullCode ? "Hide full code" : "View full code"}
            </Button>
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

          {verifyError.length > 0 && (
            <Alert className="mt-4" variant="destructive">
              <RotateCcw aria-hidden />
              <AlertTitle>Could not check install status</AlertTitle>
              <AlertDescription>
                <p>{verifyError}</p>
                <Button
                  className="mt-2 border-danger-border bg-transparent text-danger-foreground hover:text-foreground"
                  leadingIcon={RotateCcw}
                  onClick={() => void installStatusQuery.refetch()}
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
                className="mt-1.25 size-1.75 rounded-full bg-amber opacity-80 animate-pulse"
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
              <Badge color="green" size="sm" variant="dot">
                Installed
              </Badge>
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

const shortSnippetPreview = `<script>
  /* Orange Replay loader: under 2 KB, async */
</script>`;

const blockedSnippetPreview = `<script>
  /* Enter a write key and deployment URL to build the loader. */
</script>`;

function readDefaultOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

function normalizeOrigin(value: string): string | null {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) return null;

  try {
    const url = new URL(trimmedValue);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function readCopyBlockedReason({
  cleanWriteKey,
  hasActiveWriteKey,
  keysLoading,
  normalizedOrigin,
  originInput,
  writeKeyReady,
}: {
  cleanWriteKey: string;
  hasActiveWriteKey: boolean;
  keysLoading: boolean;
  normalizedOrigin: string | null;
  originInput: string;
  writeKeyReady: boolean;
}): string | null {
  if (keysLoading) return "Checking project keys.";
  if (!hasActiveWriteKey) return "Create an active write key first.";
  if (cleanWriteKey.length === 0) return "Paste the raw write key first.";
  if (!writeKeyReady) return "Use a generated write key that starts with or_live_.";
  if (originInput.trim().length === 0) return "Enter your Orange Replay URL.";
  if (normalizedOrigin === null) return "Use a valid http or https URL.";
  return null;
}

function isGeneratedWriteKey(value: string): boolean {
  return /^or_live_[A-Za-z0-9_-]{32}$/.test(value);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The API request failed.";
}
