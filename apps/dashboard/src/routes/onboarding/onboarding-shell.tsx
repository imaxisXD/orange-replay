import { useEffect, useMemo, useRef, useState } from "react";
import { LazyMotion, domMax } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { accountQueryKey, fetchAccount } from "@/lib/api";
import { accountProjects } from "@/lib/dashboard-access";
import { ArrowLeft } from "@/lib/icon-map";
import { m, useReducedMotion } from "@/lib/motion";
import {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_PATHS,
  OnboardingProvider,
  onboardingProgress,
  onboardingStepIndex,
} from "./onboarding-context";
import { FRAME, RAIL, REVEAL, onboardingAct } from "./onboarding-motion";
import { OnboardingPreview } from "./onboarding-preview";
import {
  isWebsiteProjectName,
  readWebsiteUrl,
  websiteFaviconUrl,
  websitePreviewLabel,
} from "./onboarding-website";
import "./onboarding.css";

/** Shown in the project switcher before a website has been typed. */
const PLACEHOLDER_PROJECT_LABEL = "Your website";

/**
 * The activation flow's persistent frame: the form column on the left, the live
 * dashboard preview on the right, and the state the three steps share.
 *
 * Everything that must survive a step change lives here — the website draft,
 * the recorder key minted this visit, the camera's focus, and the frame that
 * owns the height tween between steps. The steps themselves are three separate
 * routes rendered through the outlet.
 */
export function OnboardingShell() {
  const reduceMotion = useReducedMotion() === true;
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const stepIndex = onboardingStepIndex(pathname);

  const [websiteDraft, setWebsiteDraft] = useState("");
  const [recorderKey, setRecorderKey] = useState<string | null>(null);
  const [isNamingProject, setIsNamingProject] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);

  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: fetchAccount,
    staleTime: 30_000,
  });
  const account = accountQuery.data;
  const project = account === undefined ? undefined : accountProjects(account)[0];
  const projectId = project?.id ?? "";
  const savedWebsiteName =
    project !== undefined && isWebsiteProjectName(project.name) ? project.name : null;

  // Travel direction compares the current step against the last step the shell
  // committed. That bookkeeping has to happen in an effect, not during render:
  // setting state mid-render makes React throw the in-progress pass away and
  // re-render before committing, so the step actually mounted with the *updated*
  // value and Back animated as a forward move. Refs read the same on both
  // passes of a double-invoked render and only advance after commit, so the
  // mounting step sees the direction that brought it here.
  const committedStep = useRef(stepIndex);
  const hasChangedStep = useRef(false);
  const direction: 1 | -1 = stepIndex >= committedStep.current ? 1 : -1;
  const isFirstPaint = !hasChangedStep.current && committedStep.current === stepIndex;

  useEffect(() => {
    if (committedStep.current === stepIndex) return;
    committedStep.current = stepIndex;
    hasChangedStep.current = true;
  }, [stepIndex]);

  const previewProjectLabel =
    websiteDraft.trim().length > 0
      ? websitePreviewLabel(websiteDraft, PLACEHOLDER_PROJECT_LABEL)
      : (savedWebsiteName ?? PLACEHOLDER_PROJECT_LABEL);

  // Do not ask the Worker to fetch on every keystroke. A short quiet window is
  // enough to catch pasted URLs quickly while keeping normal typing to one
  // request. The API and browser cache handle repeated valid origins after it.
  useEffect(() => {
    const faviconWebsite = readWebsiteUrl(
      websiteDraft.trim().length > 0 ? websiteDraft : (savedWebsiteName ?? ""),
    );
    const nextFaviconUrl = faviconWebsite === null ? null : websiteFaviconUrl(faviconWebsite);
    setFaviconUrl(null);
    if (nextFaviconUrl === null) return;
    const timeout = window.setTimeout(() => setFaviconUrl(nextFaviconUrl), 250);
    return () => window.clearTimeout(timeout);
  }, [savedWebsiteName, websiteDraft]);

  // The camera only belongs on the switcher while the website is being named.
  // Submitting with the keyboard never blurs the field, so without this gate the
  // preview stayed zoomed on the switcher through the install and verify steps.
  const isCameraOnProject = stepIndex === 0 && isNamingProject;

  const act = onboardingAct(stepIndex, isRecording);

  const onboarding = useMemo(
    () => ({
      act,
      direction,
      faviconUrl,
      isFirstPaint,
      isNamingProject: isCameraOnProject,
      isRecording,
      previewProjectLabel,
      projectId,
      recorderKey,
      savedWebsiteName,
      setIsNamingProject,
      setIsRecording,
      setRecorderKey,
      setWebsiteDraft,
      stepIndex,
      websiteDraft,
    }),
    [
      act,
      direction,
      faviconUrl,
      isFirstPaint,
      isCameraOnProject,
      isRecording,
      previewProjectLabel,
      projectId,
      recorderKey,
      savedWebsiteName,
      stepIndex,
      websiteDraft,
    ],
  );

  function goBack(): void {
    const previousStep = ONBOARDING_STEPS[Math.max(0, stepIndex - 1)];
    if (previousStep === undefined) return;
    void navigate({ to: ONBOARDING_STEP_PATHS[previousStep], replace: true });
  }

  return (
    <OnboardingProvider value={onboarding}>
      <main className="onboarding-shell grid min-h-svh grid-cols-1 overflow-hidden bg-background text-foreground lg:grid-cols-[51.9%_48.1%]">
        <section className="relative min-h-svh bg-card lg:border-r lg:border-border">
          <div className="absolute top-6 left-6 flex items-center gap-2.5 text-[13px] font-medium">
            <BrandMark className="size-6" />
            <span>Orange Replay</span>
          </div>

          <div className="absolute top-[27.2svh] left-1/2 w-[min(394px,calc(100%-3rem))] -translate-x-1/2 max-lg:top-[19svh]">
            {/* Back sits on the form column's own leading edge, directly above
                the rail: a backwards move belongs at the start of the reading
                direction, next to the content it moves, not in the far corner
                opposite the brand. */}
            {stepIndex > 0 && (
              <Button
                className="absolute -top-9 left-0 h-7 px-2 text-[13px]"
                leadingIcon={ArrowLeft}
                onClick={goBack}
                type="button"
                variant="ghost"
              >
                Back
              </Button>
            )}

            <div
              aria-label={`Step ${stepIndex + 1} of ${ONBOARDING_STEPS.length}`}
              aria-valuemax={ONBOARDING_STEPS.length}
              aria-valuemin={1}
              aria-valuenow={stepIndex + 1}
              className="relative w-full overflow-hidden rounded-full bg-surface-6"
              role="progressbar"
              style={{ height: RAIL.height }}
            >
              <m.span
                animate={{ scaleX: onboardingProgress(stepIndex) }}
                className="block h-full origin-left rounded-full bg-amber"
                initial={reduceMotion ? false : { scaleX: 0 }}
                transition={
                  reduceMotion ? { duration: 0 } : { ...RAIL.spring, delay: REVEAL.firstPaintDelay }
                }
              />
            </div>

            {/* This frame persists across step changes, so it — not the step —
                owns the height tween between screens of different lengths.
                A size layout animation needs the projection features, which the
                app-wide MotionProvider does not load (it ships `domAnimation`),
                so this subtree loads `domMax` the same way the top nav does for
                its notch. Without it the prop is silently inert. */}
            <LazyMotion features={domMax}>
              <m.div
                className="pt-7"
                layout={reduceMotion ? false : "size"}
                transition={reduceMotion ? { duration: 0 } : FRAME.spring}
              >
                <Outlet />
              </m.div>
            </LazyMotion>
          </div>

          <p className="absolute bottom-5 left-6 text-[12px] text-dim">© Orange Replay 2026</p>
        </section>

        <section
          aria-label="Your dashboard"
          className="relative min-h-svh min-w-0 overflow-hidden max-lg:hidden"
        >
          <OnboardingPreview />
        </section>
      </main>
    </OnboardingProvider>
  );
}
