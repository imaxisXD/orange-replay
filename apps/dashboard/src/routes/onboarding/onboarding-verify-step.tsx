import { useEffect, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { fetchInstallStatus } from "@/lib/api";
import { readDashboardAccessError } from "@/lib/dashboard-access";
import { formatRelativeTime } from "@/lib/format";
import { m, useReducedMotion } from "@/lib/motion";
import { installStatusPollIntervalMs, shouldPollInstallStatus } from "@/lib/project-settings";
import { cn } from "@/lib/utils";
import { useOnboarding } from "./onboarding-context";
import { VERIFY } from "./onboarding-motion";
import { OnboardingStage } from "./onboarding-stage";

/**
 * Step 3 of 3 — the first event.
 *
 * This is the same `/install-status` poll the Install page runs, so the flow
 * ends on a fact rather than on the visitor asserting they pasted the snippet.
 * The check only draws once the project has actually received an event.
 */
export function OnboardingVerifyPage() {
  const navigate = useNavigate();
  const { previewProjectLabel, projectId, setIsRecording } = useOnboarding();

  const statusQuery = useQuery({
    queryKey: ["install-status", projectId],
    queryFn: () => fetchInstallStatus(projectId),
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
  const isConnected = firstEventAt !== null;

  // The steps are routes and cannot see each other, so the act that drives the
  // right pane lives in the shell. This is the only place that knows an event
  // arrived, so it reports it up rather than animating the preview itself.
  useEffect(() => {
    if (!isConnected) return;
    setIsRecording(true);
    const timeout = window.setTimeout(() => {
      void navigate({
        to: "/projects/$projectId/overview",
        params: { projectId },
        replace: true,
      });
    }, VERIFY.dashboardDelay);
    return () => window.clearTimeout(timeout);
  }, [isConnected, navigate, projectId, setIsRecording]);
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
    void navigate({
      to: "/projects/$projectId/overview",
      params: { projectId },
      replace: true,
    });
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
          {isConnected ? "Open your dashboard" : "Check again"}
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
              {isConnected ? "Recorder connected" : "Waiting for the first event"}
            </strong>
            <p className="mt-1 text-[12px] leading-[17px] text-muted-foreground">
              {isConnected
                ? `First event seen ${formatRelativeTime(firstEventAt)}.`
                : statusError.length > 0
                  ? statusError
                  : `Open ${previewProjectLabel} in another tab and click around.`}
            </p>
          </div>
        </div>
      }
      heading="Send your first recording"
      onSubmit={handleSubmit}
      support="Visit your site once with the snippet in place. This updates the moment data arrives."
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
