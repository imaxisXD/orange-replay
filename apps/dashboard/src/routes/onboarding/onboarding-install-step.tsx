import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { buildLoaderScriptTag } from "@orange-replay/sdk/loader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { createProjectKey, fetchProjectKeys } from "@/lib/api";
import { readDashboardAccessError } from "@/lib/dashboard-access";
import { AlertCircle, Check, Code2, Copy, KeyRound } from "@/lib/icon-map";
import { useOnboarding } from "./onboarding-context";
import { OnboardingStage } from "./onboarding-stage";

const RECORDER_KEY_NAME = "Website recorder";
const COPIED_RESET_MS = 1_500;

/**
 * Step 2 of 3 — the loader snippet.
 *
 * A raw recorder key is readable exactly once, at the moment it is created, so
 * this step mints the project's first key itself and holds it in memory for the
 * rest of the visit. A project that already has an active key cannot have its
 * raw value recovered, so that case asks before creating another one rather
 * than quietly stacking up keys on every reload.
 */
export function OnboardingInstallPage() {
  const navigate = useNavigate();
  const { projectId, recorderKey, setRecorderKey } = useOnboarding();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [showFullCode, setShowFullCode] = useState(false);

  const keysQuery = useQuery({
    queryKey: ["project-keys", projectId],
    queryFn: () => fetchProjectKeys(projectId),
  });
  const hasActiveKey = keysQuery.data?.keys.some((key) => key.active) ?? false;

  const keyMutation = useMutation({
    mutationFn: () => createProjectKey(projectId, RECORDER_KEY_NAME),
    onSuccess: (created) => {
      setRecorderKey(created.secret);
      void keysQuery.refetch();
    },
  });

  // A project reaching this step for the first time has no key at all, so the
  // snippet is ready without asking. Anything else is an explicit choice. The
  // ref makes this mint once per visit: react-query hands back a fresh mutation
  // object each render, so a plain dependency list would fire it repeatedly.
  const hasRequestedKey = useRef(false);
  const shouldMintFirstKey =
    recorderKey === null && !keysQuery.isPending && !keysQuery.isError && !hasActiveKey;
  const isPreparingKey =
    recorderKey === null && (keysQuery.isPending || keyMutation.isPending || shouldMintFirstKey);
  const revealRef = useRef<HTMLDivElement>(null);
  const wasPreparingKey = useRef(isPreparingKey);
  useEffect(() => {
    if (!shouldMintFirstKey || hasRequestedKey.current) return;
    hasRequestedKey.current = true;
    keyMutation.mutate();
  }, [keyMutation, shouldMintFirstKey]);

  // transitions.dev skeleton replay: a retry or an explicit replacement key
  // snaps back to the page-shaped skeleton before its one pulse starts again.
  useLayoutEffect(() => {
    const reveal = revealRef.current;
    const skeleton = reveal?.querySelector(".t-skel-skeleton");
    if (reveal === null || !(skeleton instanceof HTMLElement)) return;

    const wasPreparing = wasPreparingKey.current;
    wasPreparingKey.current = isPreparingKey;
    if (!isPreparingKey) {
      reveal.classList.add("is-revealed");
      return;
    }
    if (wasPreparing) return;

    reveal.classList.add("is-resetting");
    reveal.classList.remove("is-revealed");
    skeleton.classList.remove("is-pulsing");
    void skeleton.offsetWidth;
    reveal.classList.remove("is-resetting");
    skeleton.classList.add("is-pulsing");
  }, [isPreparingKey]);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const snippet =
    recorderKey === null
      ? ""
      : buildLoaderScriptTag({
          bundleUrl: `${readRecorderOrigin()}/or-recorder.js`,
          init: { ingestUrl: readRecorderOrigin(), key: recorderKey },
        });

  const keyError =
    keysQuery.error !== null
      ? readDashboardAccessError(keysQuery.error, "Could not check this project's keys.")
      : keyMutation.error !== null
        ? readDashboardAccessError(keyMutation.error, "Could not create a recorder key.")
        : "";

  async function copySnippet(): Promise<void> {
    if (snippet.length === 0) return;
    try {
      await window.navigator.clipboard.writeText(snippet);
      setCopyError("");
      setCopied(true);
    } catch (error) {
      setCopyError(readDashboardAccessError(error, "Select the snippet and copy it manually."));
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void navigate({
      to: "/onboarding/$projectId/verify",
      params: { projectId },
    });
  }

  return (
    <OnboardingStage
      action={
        <Button className="w-full" disabled={snippet.length === 0} size="lg" type="submit">
          I added the snippet
        </Button>
      }
      body={
        <div
          aria-busy={isPreparingKey}
          className="t-skel onboarding-install-reveal min-h-[158px]"
          data-state={isPreparingKey ? "loading" : "ready"}
          ref={revealRef}
        >
          <div
            aria-hidden={!isPreparingKey}
            aria-label="Preparing your recorder key"
            className="t-skel-skeleton is-pulsing flex flex-col gap-2"
            role="status"
          >
            <div className="flex h-7 items-center justify-between">
              <span className="onboarding-skeleton h-3 w-24" />
              <span className="onboarding-skeleton h-7 w-16 rounded-[7px]" />
            </div>
            <div className="h-20 rounded-lg border border-border bg-secondary p-3">
              <div className="flex flex-col gap-2">
                <span className="onboarding-skeleton h-2 w-[88%]" />
                <span className="onboarding-skeleton h-2 w-[72%]" />
                <span className="onboarding-skeleton h-2 w-[80%]" />
              </div>
            </div>
            <div className="flex h-[34px] items-start gap-2 pt-0.5">
              <span className="onboarding-skeleton size-[15px] shrink-0" />
              <span className="flex flex-1 flex-col gap-2 pt-0.5">
                <span className="onboarding-skeleton h-2 w-full" />
                <span className="onboarding-skeleton h-2 w-[76%]" />
              </span>
            </div>
          </div>

          <div aria-hidden={isPreparingKey} className="t-skel-content" inert={isPreparingKey}>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-foreground">Loader snippet</span>
                {snippet.length > 0 && (
                  <Button
                    className="h-7 px-2 text-[12px]"
                    onClick={() => void copySnippet()}
                    type="button"
                    variant="ghost"
                  >
                    {/* me-0.5 on top of the button's own gap: IconSwap's grid cell
                        is exactly the glyph's size, so unlike Button's leadingIcon
                        it carries no optical padding and reads as touching the
                        label. Logical margin so RTL flips with it. */}
                    <IconSwap className="size-3.5 me-0.5" swapKey={copied ? "check" : "copy"}>
                      {copied ? (
                        <Check aria-hidden size={14} strokeWidth={1.5} />
                      ) : (
                        <Copy aria-hidden size={14} strokeWidth={1.5} />
                      )}
                    </IconSwap>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </div>

              {/* The loader is one minified line about 1,800 characters long. Held
                  at the reference card height it showed a sixth of itself behind a
                  scrollbar, which reads as noise on a step whose only job is
                  "copy this". So the card states what the snippet is by default,
                  and the full text is one click away — the same bargain the
                  Install page strikes, and the frame tween covers the growth. */}
              <pre
                className={`${showFullCode ? "h-64" : "h-20"} overflow-auto rounded-lg border border-border bg-secondary p-3 font-mono text-[10.5px] leading-[17px] break-words whitespace-pre-wrap text-muted-foreground`}
              >
                <code>
                  {snippet.length === 0
                    ? SNIPPET_PLACEHOLDER
                    : showFullCode
                      ? snippet
                      : SNIPPET_SUMMARY}
                </code>
              </pre>

              {snippet.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    active={showFullCode}
                    aria-expanded={showFullCode}
                    className="h-7 px-2 text-[12px]"
                    leadingIcon={Code2}
                    onClick={() => setShowFullCode((isShowing) => !isShowing)}
                    type="button"
                    variant="ghost"
                  >
                    {showFullCode ? "Hide full code" : "View full code"}
                  </Button>
                </div>
              )}

              {/* The key note uses items-start, not items-center: it wraps to two
                  lines, and a centred icon would float between them instead of
                  leading the first. mt-px lands it on the first line's cap height. */}
              {snippet.length > 0 && (
                <p className="flex items-start gap-2 text-[12px] leading-[17px] text-muted-foreground">
                  <KeyRound aria-hidden className="mt-px shrink-0" size={15} strokeWidth={1.5} />
                  <span>
                    This snippet carries your recorder key. Orange Replay keeps only a hash of it,
                    so this is the only place you can copy it.
                  </span>
                </p>
              )}

              {keyError.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle aria-hidden />
                  <AlertTitle>
                    {keysQuery.error === null
                      ? "Could not create a recorder key"
                      : "Could not check this project's keys"}
                  </AlertTitle>
                  <AlertDescription>
                    <p>{keyError}</p>
                    {/* Retry the request that actually failed. Always creating a key
                        here meant a failed *read* answered with a write: a project
                        whose key list 503'd would gain a brand new key on every
                        press, walking towards the active-key limit. */}
                    <Button
                      className="mt-2 border-danger-border bg-transparent text-danger-foreground hover:text-foreground"
                      loading={
                        keysQuery.error === null ? keyMutation.isPending : keysQuery.isFetching
                      }
                      onClick={() => {
                        if (keysQuery.error !== null) {
                          void keysQuery.refetch();
                          return;
                        }
                        keyMutation.mutate();
                      }}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Try again
                    </Button>
                  </AlertDescription>
                </Alert>
              )}

              {recorderKey === null && hasActiveKey && keyError.length === 0 && (
                <Alert>
                  <AlertCircle aria-hidden />
                  <AlertTitle>This project already has a key</AlertTitle>
                  <AlertDescription>
                    <p>
                      Raw keys are readable only when they are created. Create another one to build
                      the snippet here, or copy an existing key from Settings.
                    </p>
                    <Button
                      className="mt-2"
                      loading={keyMutation.isPending}
                      onClick={() => keyMutation.mutate()}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      Create a new key
                    </Button>
                  </AlertDescription>
                </Alert>
              )}

              {copyError.length > 0 && (
                <p className="text-[12px] text-danger" role="alert">
                  {copyError}
                </p>
              )}
            </div>
          </div>
        </div>
      }
      heading="Install the recorder"
      onSubmit={handleSubmit}
      support={
        <>
          Paste this before{" "}
          <code className="font-mono text-[13px] text-foreground">&lt;/head&gt;</code> on every page
          you want to record.
        </>
      }
    />
  );
}

const SNIPPET_PLACEHOLDER = `<script>
  /* Your loader snippet appears here. */
</script>`;

const SNIPPET_SUMMARY = `<script>
  /* Orange Replay loader: under 2 KB, async */
</script>`;

function readRecorderOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

export default OnboardingInstallPage;
