import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildLoaderScriptTag } from "@orange-replay/sdk/loader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { fetchProjectKeys } from "@/lib/api";
import { AlertCircle, Check, Code2, Copy, RotateCcw } from "@/lib/icon-map";
import { AnimatePresence, m, useReducedMotion } from "@/lib/motion";
import { spring } from "@/lib/springs";
import { matchesActiveProjectWriteKey, readInstallErrorMessage } from "./install-helpers";

type KeyMatchStatus = "idle" | "checking" | "matched" | "unmatched" | "error";

interface KeyMatchState {
  activeKeyFingerprint: string;
  projectId: string;
  writeKey: string;
  status: KeyMatchStatus;
}

export function InstallSnippetBuilder({ projectId }: { projectId: string }) {
  return <ProjectInstallSnippetBuilder key={projectId} projectId={projectId} />;
}

function ProjectInstallSnippetBuilder({ projectId }: { projectId: string }) {
  const reduceMotion = useReducedMotion();
  const [writeKeyInput, setWriteKeyInput] = useState("");
  const [originInput, setOriginInput] = useState(readDefaultOrigin);
  const [copied, setCopied] = useState(false);
  const [showFullCode, setShowFullCode] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [keyMatch, setKeyMatch] = useState<KeyMatchState>({
    activeKeyFingerprint: "",
    projectId,
    writeKey: "",
    status: "idle",
  });
  const normalizedOrigin = normalizeOrigin(originInput);
  const cleanWriteKey = writeKeyInput.trim();
  const keysQuery = useQuery({
    queryKey: ["project-keys", projectId],
    queryFn: () => fetchProjectKeys(projectId),
  });
  const hasActiveWriteKey = keysQuery.data?.keys.some((key) => key.active) ?? false;
  const activeKeyHashPrefixes: string[] = [];
  for (const key of keysQuery.data?.keys ?? []) {
    if (key.active) activeKeyHashPrefixes.push(key.keyHashPrefix);
  }
  const activeKeyFingerprint = activeKeyHashPrefixes.sort().join(":");
  const originError =
    originInput.trim().length === 0
      ? "Enter your Orange Replay URL."
      : normalizedOrigin === null
        ? "Use a valid http or https URL."
        : "";
  const writeKeyReady = isGeneratedWriteKey(cleanWriteKey);
  const keyMatchStatus =
    keyMatch.projectId === projectId &&
    keyMatch.writeKey === cleanWriteKey &&
    keyMatch.activeKeyFingerprint === activeKeyFingerprint
      ? keyMatch.status
      : writeKeyReady
        ? "checking"
        : "idle";
  const keyInputError =
    cleanWriteKey.length === 0
      ? "Paste the raw write key before copying."
      : !writeKeyReady
        ? "Use a generated write key that starts with or_live_."
        : keyMatchStatus === "unmatched"
          ? "This key is not an active key for this project."
          : keyMatchStatus === "error"
            ? "The write key could not be verified. Try again."
            : "";
  const canCopySnippet =
    writeKeyReady &&
    keyMatchStatus === "matched" &&
    normalizedOrigin !== null &&
    hasActiveWriteKey &&
    !keysQuery.isPending;
  const snippet =
    canCopySnippet && normalizedOrigin !== null
      ? buildLoaderScriptTag({
          bundleUrl: `${normalizedOrigin}/or-recorder.js`,
          init: { key: cleanWriteKey, ingestUrl: normalizedOrigin },
        })
      : "";
  const shownSnippet =
    snippet.length === 0 ? blockedSnippetPreview : showFullCode ? snippet : shortSnippetPreview;
  const keysError = keysQuery.error === null ? "" : readInstallErrorMessage(keysQuery.error);
  const snippetError = copyError || keysError;
  const copyBlockedReason = readCopyBlockedReason({
    cleanWriteKey,
    hasActiveWriteKey,
    keysLoading: keysQuery.isPending,
    keyMatchStatus,
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

  useEffect(() => {
    const keys = keysQuery.data?.keys;
    if (!writeKeyReady || keys === undefined || keysQuery.isPending) return;

    let cancelled = false;
    void matchesActiveProjectWriteKey(cleanWriteKey, keys).then(
      (matches) => {
        if (!cancelled) {
          setKeyMatch({
            activeKeyFingerprint,
            projectId,
            writeKey: cleanWriteKey,
            status: matches ? "matched" : "unmatched",
          });
        }
      },
      () => {
        if (!cancelled) {
          setKeyMatch({
            activeKeyFingerprint,
            projectId,
            writeKey: cleanWriteKey,
            status: "error",
          });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [
    activeKeyFingerprint,
    cleanWriteKey,
    keysQuery.data,
    keysQuery.isPending,
    projectId,
    writeKeyReady,
  ]);

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
      setCopyError(readInstallErrorMessage(caughtError));
    }
  }

  return (
    <section className="lit rounded-lg p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium leading-tight">Loader snippet</h2>
        {keysQuery.isPending && <LoadingIndicator label="Checking project keys" />}
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Paste before <code className="font-mono text-foreground">&lt;/head&gt;</code>. Raw keys are
        shown only where you created them.
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
        <m.div
          className={showFullCode ? "h-105" : "h-24"}
          layout="size"
          transition={reduceMotion ? { duration: 0 } : spring.moderate}
        >
          <ScrollArea className="h-full" viewportClassName="scroll-fade">
            <AnimatePresence initial={false} mode="wait">
              <m.pre
                animate={{ opacity: 1, transform: "translateY(0px)" }}
                className="whitespace-pre-wrap wrap-break-word font-mono text-[11.5px] leading-relaxed text-muted-foreground"
                exit={reduceMotion ? { opacity: 1 } : { opacity: 0, transform: "translateY(-4px)" }}
                initial={reduceMotion ? false : { opacity: 0, transform: "translateY(4px)" }}
                key={showFullCode ? "full" : "preview"}
                transition={reduceMotion ? { duration: 0 } : spring.moderate}
              >
                {shownSnippet}
              </m.pre>
            </AnimatePresence>
          </ScrollArea>
        </m.div>
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
  keyMatchStatus,
  keysLoading,
  normalizedOrigin,
  originInput,
  writeKeyReady,
}: {
  cleanWriteKey: string;
  hasActiveWriteKey: boolean;
  keyMatchStatus: KeyMatchStatus;
  keysLoading: boolean;
  normalizedOrigin: string | null;
  originInput: string;
  writeKeyReady: boolean;
}): string | null {
  if (keysLoading) return "Checking project keys.";
  if (!hasActiveWriteKey) return "Create an active write key first.";
  if (cleanWriteKey.length === 0) return "Paste the raw write key first.";
  if (!writeKeyReady) return "Use a generated write key that starts with or_live_.";
  if (keyMatchStatus === "checking") return "Checking this write key.";
  if (keyMatchStatus === "unmatched") return "Use an active key from this project.";
  if (keyMatchStatus === "error") return "The write key could not be verified.";
  if (originInput.trim().length === 0) return "Enter your Orange Replay URL.";
  if (normalizedOrigin === null) return "Use a valid http or https URL.";
  return null;
}

function isGeneratedWriteKey(value: string): boolean {
  return /^or_live_[A-Za-z0-9_-]{32}$/.test(value);
}
