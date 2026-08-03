import { useEffect, useRef, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  fetchLiveSessions,
  fetchProjectWebsiteInstallStatus,
  liveSessionsQueryKey,
  projectWebsitesQueryKey,
} from "@/lib/api";
import { readDashboardAccessError } from "@/lib/dashboard-access";
import { formatRelativeTime } from "@/lib/format";
import { markLiveHandoffConnecting } from "@/lib/live-sessions";
import { m, useReducedMotion } from "@/lib/motion";
import { installStatusPollIntervalMs, shouldPollInstallStatus } from "@/lib/project-settings";
import { cn } from "@/lib/utils";
import { useOnboarding } from "./onboarding-context";
import { PREVIEW_EXIT, VERIFY } from "./onboarding-motion";
import { clearOnboardingRecorderKey } from "./onboarding-recorder-key";
import { OnboardingStage } from "./onboarding-stage";

/**
 * Step 3 of 3 — the first event.
 *
 * This polls the exact Website created in step one, so another Website's old
 * activity cannot complete this setup. After its accepted event, the handoff
 * waits for that Website's exact first session rather than any project-wide row.
 */
export function OnboardingVerifyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reduceMotion = useReducedMotion() === true;
  const {
    beginPreviewCut,
    previewProjectLabel,
    projectId,
    setIsLiveConfirmed,
    setIsRecording,
    websiteId,
  } = useOnboarding();

  const statusQuery = useQuery({
    queryKey: ["website-install-status", projectId, websiteId],
    queryFn: ({ signal }) => {
      if (websiteId === null) throw new Error("Choose a Website before checking its connection.");
      return fetchProjectWebsiteInstallStatus(projectId, websiteId, { signal });
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
  const firstEventAt = statusQuery.data?.firstEventAt ?? null;
  const firstSessionId = statusQuery.data?.firstSessionId ?? null;
  const isConnected = firstEventAt !== null;

  // The steps are routes and cannot see each other, so the act that drives the
  // right pane lives in the shell. This is the only place that knows an event
  // arrived, so it reports it up rather than animating the preview itself.
  const hasHandedOver = useRef(false);
  useEffect(() => {
    if (!isConnected || hasHandedOver.current) return;
    setIsRecording(true);
    if (websiteId !== null) clearOnboardingRecorderKey(projectId, websiteId);
    void queryClient.invalidateQueries({ queryKey: projectWebsitesQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: ["install-status", projectId] });

    let attempt: number | undefined;
    let hold: number | undefined;
    let cut: number | undefined;
    let sessionConfirmed = false;
    let stopped = false;
    const requestController = new AbortController();
    function goToLive(): void {
      // Live, not Overview: every Overview metric needs a finalised session, so
      // it is the one page guaranteed to be empty right now, while the session
      // this flow just proved exists is sitting on Live.
      void navigate({ to: "/projects/$projectId/live", params: { projectId }, replace: true });
    }
    function openLive(isConnecting = false): void {
      if (hasHandedOver.current || stopped) return;
      hasHandedOver.current = true;
      if (isConnecting) markLiveHandoffConnecting(queryClient, projectId);
      if (reduceMotion) {
        goToLive();
        return;
      }
      // The frame grows to cover the viewport first, and the route changes
      // behind it. Navigating on the same tick would swap the DOM out from
      // under a move that has not started.
      beginPreviewCut();
      cut = window.setTimeout(goToLive, PREVIEW_EXIT.duration);
    }
    function confirmSession(live: Awaited<ReturnType<typeof fetchLiveSessions>>): void {
      if (sessionConfirmed || hasHandedOver.current) return;
      sessionConfirmed = true;
      // The confirmed answer becomes the Live page's own cache entry, so the
      // page the cut lands on renders with this session already in place
      // instead of asking the same question again on arrival.
      queryClient.setQueryData(liveSessionsQueryKey(projectId), live);
      // The payoff beat: the preview's Live card fills, and the cut waits long
      // enough for "Live now" to be read before it is taken away. The cap comes
      // off — the handoff has its answer, and cutting mid-payoff would undo
      // the reason the card filled at all.
      window.clearTimeout(cap);
      setIsLiveConfirmed(true);
      if (reduceMotion) {
        openLive();
        return;
      }
      hold = window.setTimeout(() => openLive(), VERIFY.payoffHold);
    }

    // The wait is a real one. The event has landed, but the live query has not
    // necessarily caught up with the session it started, and arriving on Live a
    // second before it fills is worse than the preview's own handoff state
    // holding for that second. A failed or empty answer is not an error here —
    // it just means the cap decides instead.
    function askForTheSession(): void {
      void fetchLiveSessions(projectId, { signal: requestController.signal })
        .then((live) => {
          if (
            !stopped &&
            firstSessionId !== null &&
            live.sessions.some((session) => session.session_id === firstSessionId)
          ) {
            confirmSession(live);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (!stopped && !hasHandedOver.current && !sessionConfirmed)
            attempt = window.setTimeout(askForTheSession, VERIFY.handoffPoll);
        });
    }

    const cap = window.setTimeout(() => openLive(true), VERIFY.handoffCap);
    askForTheSession();
    return () => {
      stopped = true;
      requestController.abort();
      window.clearTimeout(cap);
      if (attempt !== undefined) window.clearTimeout(attempt);
      if (hold !== undefined) window.clearTimeout(hold);
      if (cut !== undefined) window.clearTimeout(cut);
    };
  }, [
    beginPreviewCut,
    isConnected,
    firstSessionId,
    navigate,
    projectId,
    queryClient,
    reduceMotion,
    setIsLiveConfirmed,
    setIsRecording,
    websiteId,
  ]);
  const statusError =
    statusQuery.error === null
      ? ""
      : readDashboardAccessError(statusQuery.error, "Could not check for events. Retrying.");

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!isConnected) {
      void statusQuery.refetch();
      return;
    }
    hasHandedOver.current = true;
    void navigate({ to: "/projects/$projectId/live", params: { projectId }, replace: true });
  }

  return (
    <OnboardingStage
      action={
        <Button
          className="w-full"
          loading={statusQuery.isFetching && !isConnected}
          size="lg"
          type="submit"
        >
          {isConnected ? "Go to dashboard" : "Check again"}
        </Button>
      }
      body={
        <div
          aria-live="polite"
          className="flex min-h-20.5 items-start gap-3 rounded-lg border border-border bg-secondary p-3.5"
        >
          <VerifySignal isConnected={isConnected} />
          <div>
            <strong className="text-[13px] font-medium text-foreground">
              {isConnected ? `${previewProjectLabel} is connected` : "Waiting for your website"}
            </strong>
            <p className="mt-1 text-[12px] leading-[17px] text-muted-foreground">
              {isConnected
                ? `Connected ${formatRelativeTime(firstEventAt)}.`
                : statusError.length > 0
                  ? statusError
                  : `Open ${previewProjectLabel} in another tab and browse a page.`}
            </p>
          </div>
        </div>
      }
      heading="Check your connection"
      onSubmit={handleSubmit}
      support="Open your website after adding the script. This page updates when Orange Replay connects."
    />
  );
}

/**
 * Waiting dot that becomes a drawn check. The pulse carries "still looking",
 * the colour and the label carry the state statically, and the stroke draws
 * itself so arrival reads as an event rather than a repaint.
 */
function VerifySignal({ isConnected }: { isConnected: boolean }) {
  const reduceMotion = useReducedMotion() === true;

  // One fixed slot for both states. The dot and the check are different sizes,
  // so without it the status text shifted sideways the moment an event landed.
  return (
    <span aria-hidden className="mt-0.5 grid size-4.5 shrink-0 place-items-center">
      {isConnected ? (
        <m.span
          animate={{ filter: "blur(0px)", opacity: 1, scale: 1 }}
          className={cn(
            "grid size-full place-items-center rounded-full bg-success/15",
            "shadow-[0_0_0_4px_color-mix(in_oklab,var(--success)_10%,transparent)]",
          )}
          initial={
            reduceMotion ? false : { filter: `blur(${VERIFY.checkBlur}px)`, opacity: 0, scale: 0.6 }
          }
          transition={reduceMotion ? { duration: 0 } : VERIFY.checkSpring}
        >
          <svg
            fill="none"
            height="11"
            stroke="var(--success)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 12 12"
            width="11"
          >
            <m.path
              animate={{ pathLength: 1 }}
              d="M2.5 6.5 4.8 8.8 9.5 3.5"
              initial={reduceMotion ? false : { pathLength: 0 }}
              transition={reduceMotion ? { duration: 0 } : VERIFY.strokeSpring}
            />
          </svg>
        </m.span>
      ) : (
        <span className="onboarding-signal size-2 rounded-full bg-amber shadow-[0_0_0_4px_color-mix(in_oklab,var(--amber)_12%,transparent)]" />
      )}
    </span>
  );
}

export default OnboardingVerifyPage;
