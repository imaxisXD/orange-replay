import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildLoaderScriptTag } from "@orange-replay/sdk/loader";
import { deploymentHttpOriginSchema, generatedRecorderKeySchema } from "@orange-replay/shared";
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
import { matchesActiveProjectRecorderKey, readInstallErrorMessage } from "./install-helpers";

type KeyMatchStatus = "idle" | "checking" | "matched" | "unmatched" | "error";

interface KeyMatchState {
  activeKeyFingerprint: string;
  projectId: string;
  recorderKey: string;
  status: KeyMatchStatus;
}

export function InstallSnippetBuilder({ projectId }: { projectId: string }) {
  return <ProjectInstallSnippetBuilder key={projectId} projectId={projectId} />;
}

function ProjectInstallSnippetBuilder({ projectId }: { projectId: string }) {
  const reduceMotion = useReducedMotion();
  const [recorderKeyInput, setRecorderKeyInput] = useState("");
  const [originInput, setOriginInput] = useState(readDefaultOrigin);
  const [copied, setCopied] = useState(false);
  const [showFullCode, setShowFullCode] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [keyMatch, setKeyMatch] = useState<KeyMatchState>({
    activeKeyFingerprint: "",
    projectId,
    recorderKey: "",
    status: "idle",
  });
  const parsedOrigin = deploymentHttpOriginSchema.safeParse(originInput);
  const normalizedOrigin = parsedOrigin.success ? parsedOrigin.data : null;
  const parsedRecorderKey = generatedRecorderKeySchema.safeParse(recorderKeyInput);
  const cleanRecorderKey = parsedRecorderKey.success
    ? parsedRecorderKey.data
    : recorderKeyInput.trim();
  const keysQuery = useQuery({
    queryKey: ["project-keys", projectId],
    queryFn: () => fetchProjectKeys(projectId),
  });
  const hasActiveRecorderKey = keysQuery.data?.keys.some((key) => key.active) ?? false;
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
  const recorderKeyReady = parsedRecorderKey.success;
  const keyMatchStatus =
    keyMatch.projectId === projectId &&
    keyMatch.recorderKey === cleanRecorderKey &&
    keyMatch.activeKeyFingerprint === activeKeyFingerprint
      ? keyMatch.status
      : recorderKeyReady
        ? "checking"
        : "idle";
  const keyInputError =
    cleanRecorderKey.length === 0
      ? "Paste the raw recorder key before copying."
      : !recorderKeyReady
        ? "Use a generated recorder key that starts with or_live_."
        : keyMatchStatus === "unmatched"
          ? "This key is not an active key for this project."
          : keyMatchStatus === "error"
            ? "The recorder key could not be verified. Try again."
            : "";
  const canCopySnippet =
    recorderKeyReady &&
    keyMatchStatus === "matched" &&
    normalizedOrigin !== null &&
    hasActiveRecorderKey &&
    !keysQuery.isPending;
  const snippet =
    canCopySnippet && normalizedOrigin !== null
      ? buildLoaderScriptTag({
          bundleUrl: `${normalizedOrigin}/or-recorder.js`,
          init: { key: cleanRecorderKey, ingestUrl: normalizedOrigin },
        })
      : "";
  const shownSnippet =
    snippet.length === 0 ? blockedSnippetPreview : showFullCode ? snippet : shortSnippetPreview;
  const keysError =
    keysQuery.error === null
      ? ""
      : readInstallErrorMessage(keysQuery.error, "Could not load recorder keys. Try again.");
  const snippetError = copyError || keysError;
  const copyBlockedReason = readCopyBlockedReason({
    cleanRecorderKey,
    hasActiveRecorderKey,
    keysLoading: keysQuery.isPending,
    keyMatchStatus,
    normalizedOrigin,
    originInput,
    recorderKeyReady,
  });
  const copyButtonLabel = copied ? "Copied" : (copyBlockedReason ?? "Copy snippet");

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  useEffect(() => {
    const keys = keysQuery.data?.keys;
    if (!recorderKeyReady || keys === undefined || keysQuery.isPending) return;

    let cancelled = false;
    void matchesActiveProjectRecorderKey(cleanRecorderKey, keys).then(
      (matches) => {
        if (!cancelled) {
          setKeyMatch({
            activeKeyFingerprint,
            projectId,
            recorderKey: cleanRecorderKey,
            status: matches ? "matched" : "unmatched",
          });
        }
      },
      () => {
        if (!cancelled) {
          setKeyMatch({
            activeKeyFingerprint,
            projectId,
            recorderKey: cleanRecorderKey,
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
    cleanRecorderKey,
    keysQuery.data,
    keysQuery.isPending,
    projectId,
    recorderKeyReady,
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
    } catch {
      setCopyError("Could not copy the snippet. Select the code and copy it manually.");
    }
  }

  return (
    <section className="lit rounded-lg p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium leading-tight">Loader snippet</h2>
        {keysQuery.isPending && <LoadingIndicator label="Checking recorder keys" />}
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Paste before <code className="font-mono text-foreground">&lt;/head&gt;</code>. Raw keys are
        shown only where you created them.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <InputGroup className="w-full gap-0">
          <InputField
            autoComplete="off"
            error={keyInputError.length > 0 && recorderKeyInput.length > 0 ? keyInputError : ""}
            index={0}
            label="Recorder key"
            onChange={(value) => {
              setRecorderKeyInput(value);
              setCopied(false);
              setCopyError("");
            }}
            placeholder="Paste the raw key"
            type="password"
            value={recorderKeyInput}
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
            {keysError.length > 0 ? "Could not load recorder keys" : "Snippet not ready"}
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
        !hasActiveRecorderKey &&
        keysError.length === 0 &&
        copyError.length === 0 && (
          <Alert className="mt-4">
            <AlertCircle aria-hidden />
            <AlertTitle>No active recorder key</AlertTitle>
            <AlertDescription>
              Create a recorder key in Settings, then paste the raw key here.
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
        {/* `t-resize`, not `layout="size"`. The layout animation fakes the size
            with a transform, and measured mid-flight it held this card at
            `scaleY(0.80)` with its children uncorrected, so the snippet was
            squashed by a fifth while the card grew. */}
        <div className={`t-resize ${showFullCode ? "h-105" : "h-24"}`}>
          <ScrollArea
            className="h-full"
            // Base UI puts `min-width: fit-content` inline on its content
            // wrapper to measure horizontal overflow. The loader is one minified
            // line, so that sized the content past the card and, with no
            // horizontal scrollbar on a vertical scroller, most of the snippet
            // could not be reached. Auto width lets `whitespace-pre-wrap` work.
            viewportClassName="scroll-fade [&>[role=presentation]]:!min-w-0"
          >
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
        </div>
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
  /* Enter a recorder key and deployment URL to build the loader. */
</script>`;

function readDefaultOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

function readCopyBlockedReason({
  cleanRecorderKey,
  hasActiveRecorderKey,
  keyMatchStatus,
  keysLoading,
  normalizedOrigin,
  originInput,
  recorderKeyReady,
}: {
  cleanRecorderKey: string;
  hasActiveRecorderKey: boolean;
  keyMatchStatus: KeyMatchStatus;
  keysLoading: boolean;
  normalizedOrigin: string | null;
  originInput: string;
  recorderKeyReady: boolean;
}): string | null {
  if (keysLoading) return "Checking recorder keys.";
  if (!hasActiveRecorderKey) return "Create an active recorder key first.";
  if (cleanRecorderKey.length === 0) return "Paste the raw recorder key first.";
  if (!recorderKeyReady) return "Use a generated recorder key that starts with or_live_.";
  if (keyMatchStatus === "checking") return "Checking this recorder key.";
  if (keyMatchStatus === "unmatched") return "Use an active key from this project.";
  if (keyMatchStatus === "error") return "The recorder key could not be verified.";
  if (originInput.trim().length === 0) return "Enter your Orange Replay URL.";
  if (normalizedOrigin === null) return "Use a valid http or https URL.";
  return null;
}
