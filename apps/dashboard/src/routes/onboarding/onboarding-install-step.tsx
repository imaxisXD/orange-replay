import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { buildLoaderScriptTag, buildLoaderSnippet } from "@orange-replay/sdk/loader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TabItem, TabPanel, Tabs, TabsList } from "@/components/ui/tabs";
import type { ProjectWebsite } from "@orange-replay/shared";
import {
  fetchProjectWebsiteInstallStatus,
  fetchProjectWebsiteSetup,
  projectWebsitesQueryKey,
} from "@/lib/api";
import { readDashboardAccessError } from "@/lib/dashboard-access";
import { AlertCircle, Code2, Copy, CopyCheck, Global } from "@/lib/icon-map";
import { useReducedMotion } from "@/lib/motion";
import { installStatusPollIntervalMs, shouldPollInstallStatus } from "@/lib/project-settings";
import {
  INSTALL_TARGETS,
  buildInstallSnippet,
  buildInstallSummary,
  findInstallTarget,
  installProseParts,
} from "./install-targets";
import { OnboardingConnectedWebsite } from "./onboarding-connected-website";
import { useOnboarding } from "./onboarding-context";
import {
  clearOnboardingRecorderKey,
  readOnboardingRecorderKey,
  saveOnboardingRecorderKey,
} from "./onboarding-recorder-key";
import { readWebsiteSetupError } from "./onboarding-setup-error";
import { OnboardingStage } from "./onboarding-stage";

const COPIED_RESET_MS = 1_500;

/**
 * Step 2 of 3 — the loader snippet.
 *
 * Step one has already created or reused the Website installation. This step
 * only reads that setup, so refreshes and parallel tabs cannot create extras.
 */
export function OnboardingInstallPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    previewProjectLabel,
    projectId,
    recorderKey,
    installTargetId,
    registerStatusPoll,
    setInstallTargetId,
    setIsRecording,
    setRecorderKey,
    setWebsiteDraft,
    websiteId,
  } = useOnboarding();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [connectedWebsite, setConnectedWebsite] = useState<ProjectWebsite | null>(null);
  const [showFullCode, setShowFullCode] = useState(false);
  const target = findInstallTarget(installTargetId);

  const availableRecorderKey =
    recorderKey ?? (websiteId === null ? null : readOnboardingRecorderKey(projectId, websiteId));

  const setupMutation = useMutation({
    mutationFn: async () => {
      if (websiteId === null) throw new Error("Choose a Website before preparing its snippet.");
      return fetchProjectWebsiteSetup(projectId, websiteId);
    },
    onSuccess: (created) => {
      setWebsiteDraft(created.website.origin);
      void queryClient.invalidateQueries({ queryKey: projectWebsitesQueryKey(projectId) });
      if (created.alreadyConnected) {
        if (websiteId !== null) clearOnboardingRecorderKey(projectId, websiteId);
        setRecorderKey(null);
        setConnectedWebsite(created.website);
        return;
      }
      if (created.secret === null || websiteId === null) return;
      saveOnboardingRecorderKey(projectId, websiteId, created.secret);
      setRecorderKey(created.secret);
      void queryClient.invalidateQueries({ queryKey: ["project-keys", projectId] });
    },
  });

  // Confirm the Website once per mount even when this tab already has its
  // script. That lets another tab's successful connection replace stale setup
  // with the clear already-connected state without creating anything new.
  const hasRequestedSetup = useRef(false);
  const shouldLoadWebsiteSetup =
    websiteId !== null && !hasRequestedSetup.current && !setupMutation.isError;
  const isPreparingKey =
    availableRecorderKey === null && (setupMutation.isPending || shouldLoadWebsiteSetup);
  const revealRef = useRef<HTMLDivElement>(null);
  const wasPreparingKey = useRef(isPreparingKey);
  useEffect(() => {
    if (!shouldLoadWebsiteSetup || hasRequestedSetup.current) return;
    hasRequestedSetup.current = true;
    setupMutation.mutate();
  }, [setupMutation, shouldLoadWebsiteSetup]);

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

  // This step waits for the event itself, which is why it has no Continue
  // button: there is nothing for the visitor to confirm. The poll is the same
  // one the verify step runs — same interval, same "not while the tab is
  // hidden" rule — because it is the same question asked from one screen
  // earlier.
  const statusQuery = useQuery({
    queryKey: ["website-install-status", projectId, websiteId],
    queryFn: () => {
      if (websiteId === null) throw new Error("Choose a Website before checking its connection.");
      return fetchProjectWebsiteInstallStatus(projectId, websiteId);
    },
    enabled: websiteId !== null,
    refetchInterval: (query) => {
      if (query.state.data?.firstEventAt != null) return false;
      return shouldPollInstallStatus(document.visibilityState)
        ? installStatusPollIntervalMs
        : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const isConnected = (statusQuery.data?.firstEventAt ?? null) !== null;

  // Each completed poll rings the preview's verify card once. `dataUpdatedAt`
  // is the honest trigger: it moves when an answer actually arrives, so the ring
  // means "I just checked" rather than "a timer went off".
  const lastPollAt = useRef(0);
  const polledAt = statusQuery.dataUpdatedAt;
  useEffect(() => {
    if (polledAt === 0 || polledAt === lastPollAt.current) return;
    lastPollAt.current = polledAt;
    registerStatusPoll();
  }, [polledAt, registerStatusPoll]);

  // The handover is automatic and one-way. `setIsRecording` moves the preview
  // into act 2 before the navigation, so the Live page fills on the pane that is
  // already showing it rather than after a screen swap.
  useEffect(() => {
    if (!isConnected) return;
    setIsRecording(true);
    void navigate({
      to: "/onboarding/$projectId/verify",
      params: { projectId },
      search: websiteId === null ? {} : { website: websiteId },
      replace: true,
    });
  }, [isConnected, navigate, projectId, setIsRecording, websiteId]);

  // The loader is built once in both shapes, because a target either pastes the
  // whole tag or embeds the bare body inside framework code.
  const loaderConfig =
    availableRecorderKey === null
      ? null
      : {
          bundleUrl: `${readRecorderOrigin()}/or-recorder.js`,
          init: { ingestUrl: readRecorderOrigin(), key: availableRecorderKey },
        };
  const snippet =
    loaderConfig === null
      ? ""
      : buildInstallSnippet(installTargetId, {
          body: buildLoaderSnippet(loaderConfig),
          tag: buildLoaderScriptTag(loaderConfig),
        });

  const keyError =
    websiteId === null
      ? "Go back and choose the Website you want to install."
      : setupMutation.error === null || availableRecorderKey !== null
        ? ""
        : readWebsiteSetupError(setupMutation.error);

  if (connectedWebsite !== null) {
    return (
      <OnboardingConnectedWebsite
        onAddAnother={() =>
          void navigate({
            to: "/onboarding/$projectId/website",
            params: { projectId },
            replace: true,
          })
        }
        website={connectedWebsite}
      />
    );
  }

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

  // Switching stacks changes what Copy would paste, so a "Copied" badge left
  // over from the previous target would be claiming something untrue.
  function handleTargetChange(nextTargetId: string): void {
    setInstallTargetId(findInstallTarget(nextTargetId).id);
    setCopied(false);
    setCopyError("");
  }

  // Nothing to submit: the step advances on the event, not on a click. Enter in
  // the code card must still not reload the page.
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
  }

  return (
    <OnboardingStage
      // No action. Continue is gone because there is nothing to confirm — the
      // step polls for the event itself — and the waiting state it would have
      // announced belongs to the preview, which is already showing the page
      // that visitor will appear on. Restating it here would be the same
      // sentence twice, on the pane that is not the subject.
      action={null}
      body={
        <>
          {/* The stack picker sits outside the reveal below. Nothing about it
              waits on the recorder key, so a visitor can find their framework
              while the key is still being prepared, and the row does not
              re-enter every time the key state changes. */}
          <Tabs onValueChange={handleTargetChange} value={installTargetId}>
            {/* Wraps rather than overflows: five tabs fit the 394px column, but
                the column is `calc(100% - 3rem)` on a phone. */}
            <TabsList aria-label="Your stack" className="w-full flex-wrap">
              {INSTALL_TARGETS.map((installTarget) => (
                <TabItem
                  // Five tabs share a 394px column, so they run tighter than the
                  // registry default: at `px-3` the row wrapped and left Svelte
                  // alone on a second line. Equal flex cells then spend the
                  // leftover width instead of leaving it dead at the row's end.
                  //
                  // Marks stay at full colour, because recognizing your own
                  // stack at a glance is the only reason they are here; the
                  // sliding indicator and the semibold label already say which
                  // one is selected.
                  className="flex-1 justify-center gap-1.5 px-1"
                  icon={installTarget.mark}
                  key={installTarget.id}
                  label={installTarget.label}
                  value={installTarget.id}
                />
              ))}
            </TabsList>

            {/* One panel per target, so each tab controls real content rather
                than pointing at nothing. Base UI unmounts the inactive ones —
                but not synchronously: the outgoing panel stays mounted with
                `data-ending-style` until an animation frame after the switch.
                Stacked as siblings, that frame showed two panels and shoved
                everything below the picker down a row and back — the jump this
                grid removes. One shared cell holds the height, and the ending
                panel is hidden the instant it starts leaving. */}
            <div className="grid">
              {INSTALL_TARGETS.map((installTarget) => (
                <TabPanel
                  // 10px, tighter than the 20px that follows: this sentence is
                  // the selected tab's own content, so it has to read as
                  // belonging to the picker. At the 14px it started on it sat
                  // equidistant between the tabs and the card and belonged to
                  // neither.
                  className="col-start-1 row-start-1 pt-2.5 text-[12.5px] leading-[18px] text-muted-foreground data-[ending-style]:invisible"
                  key={installTarget.id}
                  value={installTarget.id}
                >
                  {/* Every instruction is stacked invisibly under the visible one
                    — the SwapText `widest` device, applied to a paragraph — so
                    each panel is as tall as the tallest sentence. The
                    instructions run one to three lines, and without the reserve
                    the code card below jumped on every tab change. */}
                  <span className="grid">
                    {INSTALL_TARGETS.map((measuredTarget) => (
                      <span
                        aria-hidden={measuredTarget.id !== installTarget.id || undefined}
                        className={`col-start-1 row-start-1 ${
                          measuredTarget.id === installTarget.id ? "" : "invisible"
                        }`}
                        key={measuredTarget.id}
                      >
                        <InstallProse text={measuredTarget.instruction} />
                      </span>
                    ))}
                  </span>
                </TabPanel>
              ))}
            </div>
          </Tabs>

          {/* 20px, twice the picker's internal 10px, because the artifact is a
              different group from the instructions that describe it. The
              min-height reserves the collapsed content's exact height so the
              skeleton and the controls can share one slot: 28 header + 8 + 80
              card + 8 + 28 expander + 20 + 34 note. */}
          <div
            aria-busy={isPreparingKey}
            className="t-skel onboarding-install-reveal mt-5 min-h-[206px]"
            data-state={isPreparingKey ? "loading" : "ready"}
            ref={revealRef}
          >
            <div
              aria-hidden={!isPreparingKey}
              aria-label="Preparing your installation script"
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
              {/* The expander row. Without it the skeleton was 48px shorter than
                  the controls it stands in for, so revealing them grew the frame
                  instead of swapping in place. */}
              <div className="flex h-7 justify-end">
                <span className="onboarding-skeleton h-7 w-26 rounded-[7px]" />
              </div>
              {/* The same 20px the real note gets, so the skeleton carries the
                  grouping too rather than an even stack of four blocks. */}
              <div className="mt-3 flex h-[34px] items-start gap-2 pt-0.5">
                <span className="onboarding-skeleton size-[15px] shrink-0" />
                <span className="flex flex-1 flex-col gap-2 pt-0.5">
                  <span className="onboarding-skeleton h-2 w-full" />
                  <span className="onboarding-skeleton h-2 w-[76%]" />
                </span>
              </div>
            </div>

            <div aria-hidden={isPreparingKey} className="t-skel-content" inert={isPreparingKey}>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  {/* The card is titled with the file being edited, not with
                    "Installation script". Naming the artifact was a label; the
                    file answers the question the visitor actually has, and it
                    costs no extra height because the row already existed. Its
                    file-type mark is the same bet as the framework tabs: a
                    developer reads a blue TS square faster than ".tsx". */}
                  <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
                    <target.siteMark
                      aria-hidden
                      className={`shrink-0 ${target.siteMarkClass}`}
                      size={17}
                      strokeWidth={1.5}
                    />
                    <span className="truncate">
                      <InstallProse text={target.site} />
                    </span>
                  </span>
                  {snippet.length > 0 && (
                    <Button
                      // Copy is what this step is for, so it reads as a control
                      // rather than as a text link. It stays `secondary` and not
                      // `primary`: the light-filled plate belongs to Continue,
                      // and two of them on one screen would argue about which
                      // one finishes the step.
                      // `sm` is sized for a page toolbar; this sits in a card
                      // header next to a 13px filename, so it keeps the plate
                      // and drops the padding to match the row it lives in.
                      className="h-7 shrink-0 px-2.5 text-[12px]"
                      onClick={() => void copySnippet()}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {/* A flex row at the button's own `gap-1.5`, the glyph
                          sized in CSS, and a green check on success. Green is
                          the confirmation, not just the animation: motion is
                          never the only feedback channel.

                          The row matters structurally too. `Button` wraps its
                          children in a cap-height text-box trim, which is right
                          for a bare label but shifted the glyph when the glyph
                          shared that box. `text-box-trim` is inert on a flex
                          container, so wrapping here hands the trim to the label
                          span where it belongs and both sit on one centred
                          line. */}
                      <span className="flex items-center gap-1.5">
                        <CopyStateGlyph copied={copied} />
                        <SwapText value={copied ? "Copied" : "Copy"} widest="Copied" />
                      </span>
                    </Button>
                  )}
                </div>

                {/* Collapsed by default, and the collapsed line states the real
                  byte count of what Copy will paste. See `buildInstallSummary`
                  for why. The frame tween covers the growth when it expands.

                  Same construction as the Install page's code card, down to the
                  padding and the border on the box, the shared `ScrollArea`
                  filling it, and `scroll-fade` masking the overflow edges. Its
                  48px mask only engages while there is something to scroll, so
                  the collapsed three-line summary is untouched.

                  The height tweens through transitions.dev's card-resize recipe,
                  not framer-motion's `layout="size"`. The layout animation fakes
                  the size with a transform, and measuring it mid-flight caught the
                  card at `scaleY(0.80)` with its children uncorrected: the code
                  text was squashed by a fifth while it grew. The Install page's
                  card has the same tell. */}
                <div
                  className={`t-resize ${showFullCode ? "h-64" : "h-20"} rounded-lg border border-border bg-secondary p-3`}
                >
                  <ScrollArea
                    className="h-full"
                    // Base UI sets `min-width: fit-content` inline on its
                    // content wrapper so it can measure horizontal overflow.
                    // The loader is one minified line, so `fit-content` sized it
                    // to 1289px inside a 368px viewport: the code laid out
                    // sideways instead of wrapping, and with no horizontal
                    // scrollbar most of it was unreachable. This scroller is
                    // vertical by design, so the wrapper goes back to auto width
                    // and `whitespace-pre-wrap` does its job.
                    viewportClassName="scroll-fade [&>[role=presentation]]:!min-w-0"
                  >
                    <pre className="font-mono text-[10.5px] leading-[17px] break-words whitespace-pre-wrap text-muted-foreground">
                      <code>
                        {showFullCode && snippet.length > 0
                          ? snippet
                          : buildInstallSummary(installTargetId, snippet.length)}
                      </code>
                    </pre>
                  </ScrollArea>
                </div>

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

                {/* The Website note uses items-start, not items-center: it wraps to two
                  lines, and a centred icon would float between them instead of
                  leading the first. mt-px lands it on the first line's cap height. */}
                {/* 20px above, not the group's 8px: the file title, the code and
                    the expander are one artifact, and this is a fact about which
                    website that artifact belongs to. At 8px all four read as one
                    even stack. The icon holds the column's leading edge and the
                    text hangs off it, so the paragraph still aligns with the
                    instruction above. */}
                {snippet.length > 0 && (
                  <p className="mt-3 flex items-start gap-2 text-[12px] leading-[17px] text-muted-foreground">
                    <Global aria-hidden className="mt-px shrink-0" size={15} strokeWidth={1.5} />
                    <span>
                      This tag records {previewProjectLabel}. Another domain, like a staging copy,
                      needs its own website.
                    </span>
                  </p>
                )}

                {keyError.length > 0 && (
                  <Alert variant="destructive">
                    <AlertCircle aria-hidden />
                    <AlertTitle>Could not prepare the installation script</AlertTitle>
                    <AlertDescription>
                      <p>{keyError}</p>
                      <Button
                        className="mt-2 border-danger-border bg-transparent text-danger-foreground hover:text-foreground"
                        loading={setupMutation.isPending}
                        onClick={() => setupMutation.mutate()}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        Try again
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
        </>
      }
      heading="Install the snippet"
      onSubmit={handleSubmit}
      // No supporting line. The stack picker below names the file and the
      // placement, so a sentence here only agreed with the instruction two rows
      // under it, and it cost a chunk of a 394px column to do that.
    />
  );
}

/**
 * transitions.dev's success check, replacing the copy glyph.
 *
 * The check does not cross-fade with the copy mark, it arrives: the wrapper
 * fades, unrotates from 80deg, clears a blur and bobs up while the tick draws
 * its own stroke. The copy mark leaves on the label's timing so the two halves of
 * the button are never mid-flight against each other.
 *
 * Both glyphs share one grid cell, so nothing in the row shifts during the swap,
 * and the check is `--success` green: the colour is the state, the animation is
 * only how it got here.
 */
function CopyStateGlyph({ copied }: { copied: boolean }) {
  return (
    <span className="grid size-3.5 shrink-0 place-items-center">
      <Copy
        aria-hidden
        className="t-copy-glyph col-start-1 row-start-1 size-3.5"
        data-state={copied ? "out" : "in"}
      />
      {/* `CopyCheck` is `Copy` plus one path, the tick, so the frame lands in the
          same place and only the tick is new. The draw in `onboarding.css` is
          scoped to that first path for exactly this reason: drawing the frame too
          would animate two rounded rectangles nobody asked to see redrawn.

          The entrance is delayed past the copy glyph's exit rather than
          overlapping it. Both glyphs carry the same frame, so a cross-fade under
          an 80deg rotation showed the frame twice at two angles. */}
      <span
        aria-hidden
        className="t-success-check col-start-1 row-start-1 text-success"
        data-state={copied ? "in" : "out"}
      >
        <CopyCheck aria-hidden className="size-3.5" strokeWidth={1.5} />
      </span>
    </span>
  );
}

/**
 * transitions.dev's three-phase text swap for the button's label.
 *
 * The old word slides up and blurs out, the text is replaced while nothing is
 * visible, and the new word animates home from below. Phase three needs the
 * browser to see the start position before the class comes off, which is what the
 * forced reflow in the layout effect buys — the same device the skeleton reset
 * above uses.
 *
 * `widest` is rendered invisibly underneath so the button reserves the longer
 * label's width from the start. Without it the button's left edge jumped 10px
 * mid-swap, which is a bigger movement than the animation it interrupted.
 */
function SwapText({ value, widest }: { value: string; widest: string }) {
  const reduceMotion = useReducedMotion() === true;
  const [shown, setShown] = useState(value);
  const [phase, setPhase] = useState<"rest" | "exit" | "enter">("rest");
  const labelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (value === shown) return;
    if (reduceMotion) {
      setShown(value);
      return;
    }

    setPhase("exit");
    const timeout = window.setTimeout(() => {
      setShown(value);
      setPhase("enter");
    }, readTextSwapDuration(labelRef.current));
    return () => window.clearTimeout(timeout);
  }, [reduceMotion, shown, value]);

  useLayoutEffect(() => {
    if (phase !== "enter") return;
    // Reading layout flushes the below-and-blurred start position into style, so
    // removing the class transitions from there instead of jumping.
    void labelRef.current?.offsetWidth;
    setPhase("rest");
  }, [phase]);

  return (
    <span className="grid">
      <span
        aria-hidden
        className="invisible col-start-1 row-start-1 [text-box:trim-both_cap_alphabetic]"
      >
        {widest}
      </span>
      <span
        className={`t-text-swap col-start-1 row-start-1 [text-box:trim-both_cap_alphabetic] ${
          phase === "exit" ? "is-exit" : phase === "enter" ? "is-enter-start" : ""
        }`}
        ref={labelRef}
      >
        {shown}
      </span>
    </span>
  );
}

/**
 * The swap's exit duration, read from the CSS that owns it. Same approach as the
 * website field's shake: the recipe's timing lives in `onboarding.css`, and the
 * JS that sequences it asks rather than keeping a second copy that can drift.
 */
function readTextSwapDuration(node: HTMLElement | null): number {
  const fallback = 150;
  if (node === null) return fallback;
  const value = Number.parseFloat(
    window.getComputedStyle(node).getPropertyValue("--text-swap-dur"),
  );
  return Number.isFinite(value) ? value : fallback;
}

/**
 * A placement sentence with its code spans in mono. Backticks are the source
 * format in `install-targets`, so a file path or an HTML tag reads as code
 * without the table knowing anything about markup.
 */
function InstallProse({ text }: { text: string }) {
  return (
    <>
      {installProseParts(text).map((part, index) =>
        part.code ? (
          <code className="font-mono text-[0.95em] text-foreground" key={`${index}-${part.text}`}>
            {part.text}
          </code>
        ) : (
          <span key={`${index}-${part.text}`}>{part.text}</span>
        ),
      )}
    </>
  );
}

function readRecorderOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

export default OnboardingInstallPage;
