import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { LazyMotion, domMax } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import {
  accountQueryKey,
  fetchAccount,
  fetchProjectWebsites,
  projectWebsitesQueryKey,
} from "@/lib/api";
import { findAccountProject } from "@/lib/dashboard-access";
import { ArrowLeft } from "@/lib/icon-map";
import { m, useReducedMotion } from "@/lib/motion";
import { findReusableEmptyProjectId } from "@/lib/website-journey";
import { ONBOARDING_STEPS, OnboardingProvider, onboardingStepIndex } from "./onboarding-context";
import { DEFAULT_INSTALL_TARGET, type InstallTargetId } from "./install-targets";
import { FRAME, PREVIEW_EXIT, RAIL, onboardingAct } from "./onboarding-motion";
import { OnboardingPreview } from "./onboarding-preview";
import { StepRailTwinkle } from "./step-rail-twinkle";
import {
  isWebsiteProjectName,
  readWebsiteUrl,
  websiteFaviconUrl,
  websitePreviewLabel,
  websitePreviewSource,
} from "./onboarding-website";
import "./onboarding.css";

/** Shown in the project switcher before a website has been typed. */
const PLACEHOLDER_PROJECT_LABEL = "Your website";

/**
 * The activation flow's persistent frame: the form column on the left, the live
 * dashboard preview on the right, and the state the three steps share.
 *
 * Everything that must survive a step change lives here — the website draft,
 * its internal installation key, the camera's focus, and the frame that owns
 * the height tween between steps. The steps themselves are three separate
 * routes rendered through the outlet.
 */
export function OnboardingShell() {
  const reduceMotion = useReducedMotion() === true;
  const navigate = useNavigate();
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchedWebsiteId = useRouterState({
    select: (state) => {
      const value = (state.location.search as { website?: unknown }).website;
      return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
    },
  });
  const searchedWebsiteDraft = useRouterState({
    select: (state) => {
      const value = (state.location.search as { draft?: unknown }).draft;
      return typeof value === "string" ? value : "";
    },
  });
  const stepIndex = onboardingStepIndex(pathname);

  const [websiteDraft, setWebsiteDraft] = useState(searchedWebsiteDraft);
  const [websiteId, setWebsiteId] = useState<string | null>(searchedWebsiteId);
  const [recorderKey, setRecorderKey] = useState<string | null>(null);
  const [isNamingProject, setIsNamingProject] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isLiveConfirmed, setIsLiveConfirmed] = useState(false);
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const [pollTick, setPollTick] = useState(0);
  // Step two's stack choice lives here, not in the step: the preview mirrors it,
  // and the two are on opposite sides of a route boundary.
  const [installTargetId, setInstallTargetId] = useState<InstallTargetId>(DEFAULT_INSTALL_TARGET);
  const [isLeaving, setIsLeaving] = useState(false);
  const seededEditWebsiteId = useRef<string | null>(null);

  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: fetchAccount,
    staleTime: 30_000,
  });
  const account = accountQuery.data;
  const project = findAccountProject(account, projectId);
  const websitesQuery = useQuery({
    queryKey: projectWebsitesQueryKey(projectId),
    queryFn: () => fetchProjectWebsites(projectId),
    enabled: stepIndex === 0,
    staleTime: 30_000,
  });
  const searchedWebsite = websitesQuery.data?.websites.find(
    (website) => website.id === searchedWebsiteId,
  );
  const editingWebsiteId =
    stepIndex === 0 && searchedWebsite?.firstEventAt === null ? searchedWebsite.id : null;
  const editingWebsiteOrigin = editingWebsiteId === null ? null : (searchedWebsite?.origin ?? null);
  const activeWebsiteDraft =
    editingWebsiteId !== null &&
    searchedWebsite !== undefined &&
    seededEditWebsiteId.current !== editingWebsiteId
      ? searchedWebsite.origin
      : websiteDraft;
  const websiteCount = websitesQuery.data?.websites.length;
  // The route guard preloads this state before Step 1 renders. The name check
  // remains only as a safe fallback for later steps, where this query is
  // intentionally disabled because the exact Website id is already known.
  const isFirstWebsite =
    websiteCount === undefined ? project?.name === "Default project" : websiteCount === 0;
  const workspaceName = project === undefined || isFirstWebsite ? null : project.name;
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

  // Where the rail's light runs, as fractions of the whole rule. It covers the
  // ground this navigation added and no more: from nothing at first paint, and
  // from the step left behind on every move after it. The span is what the run
  // is paid for, so the edge keeps one speed whether it crosses a third or all
  // of it. Same ref as `direction`, and for the same reason — it holds the step
  // this render arrived from until the commit below advances it.
  const railTo = (stepIndex + 1) / ONBOARDING_STEPS.length;
  const railFrom = isFirstPaint ? 0 : (committedStep.current + 1) / ONBOARDING_STEPS.length;
  const railSpan = Math.abs(railTo - railFrom);

  useEffect(() => {
    if (committedStep.current === stepIndex) return;
    committedStep.current = stepIndex;
    hasChangedStep.current = true;
  }, [stepIndex]);

  useEffect(() => {
    if (searchedWebsiteId !== null) setWebsiteId(searchedWebsiteId);
  }, [searchedWebsiteId]);

  useEffect(() => {
    if (editingWebsiteId === null || searchedWebsite === undefined) return;
    if (seededEditWebsiteId.current === editingWebsiteId) return;
    seededEditWebsiteId.current = editingWebsiteId;
    setWebsiteDraft(searchedWebsite.origin);
  }, [editingWebsiteId, searchedWebsite]);

  const previewWebsiteSource = websitePreviewSource(
    activeWebsiteDraft,
    savedWebsiteName,
    stepIndex > 0,
  );
  const previewProjectLabel = websitePreviewLabel(previewWebsiteSource, PLACEHOLDER_PROJECT_LABEL);
  const previewWebsite = readWebsiteUrl(previewWebsiteSource);
  const expectedFaviconUrl = previewWebsite === null ? null : websiteFaviconUrl(previewWebsite);
  // Do not wait for the effect below to clear an old icon. Effects run after
  // paint, so deriving the visible value here guarantees that clearing or
  // replacing the draft cannot flash a favicon from the previous website.
  const visibleFaviconUrl = faviconUrl === expectedFaviconUrl ? faviconUrl : null;

  // Do not ask the Worker to fetch on every keystroke. A short quiet window is
  // enough to catch pasted URLs quickly while keeping normal typing to one
  // request. The API and browser cache handle repeated valid origins after it.
  useEffect(() => {
    setFaviconUrl((currentFaviconUrl) =>
      currentFaviconUrl === expectedFaviconUrl ? currentFaviconUrl : null,
    );
    if (expectedFaviconUrl === null) return;
    const timeout = window.setTimeout(() => setFaviconUrl(expectedFaviconUrl), 250);
    return () => window.clearTimeout(timeout);
  }, [expectedFaviconUrl]);

  // The camera only belongs on the switcher while the website is being named.
  // Submitting with the keyboard never blurs the field, so without this gate the
  // preview stayed zoomed on the switcher through the install and verify steps.
  const isCameraOnProject = stepIndex === 0 && isNamingProject;

  const act = onboardingAct(stepIndex, isRecording);

  // Step two owns the poll and the preview owns the ring it fires; neither can
  // reach the other. Same reason the verify step reports the first event up.
  const registerStatusPoll = useCallback(() => setPollTick((tick) => tick + 1), []);
  // Variant B's cut has to outlive the step that started it — the route changes
  // while it is still running — so the shell holds it and takes the form column
  // with it.
  const beginPreviewCut = useCallback(() => setIsLeaving(true), []);

  const accountWorkspace = account?.workspaces.find((workspace) =>
    workspace.projects.some((accountProject) => accountProject.id === projectId),
  );
  const accountWorkspaceId = accountWorkspace?.id ?? null;
  const journeyDomain = project?.journeyDomain;
  const emptyProjectId = findReusableEmptyProjectId(projectId, accountWorkspace?.projects ?? []);
  const journeyOrigins = useMemo(
    () => websitesQuery.data?.websites.map((website) => website.origin) ?? [],
    [websitesQuery.data],
  );

  const onboarding = useMemo(
    () => ({
      accountWorkspaceId,
      act,
      beginPreviewCut,
      direction,
      editingWebsiteId,
      editingWebsiteOrigin,
      emptyProjectId,
      faviconUrl: visibleFaviconUrl,
      isFirstPaint,
      isFirstWebsite,
      isLeaving,
      isNamingProject: isCameraOnProject,
      isRecording,
      isLiveConfirmed,
      installTargetId,
      journeyDomain,
      journeyOrigins,
      pollTick,
      registerStatusPoll,
      setInstallTargetId,
      previewProjectLabel,
      projectId,
      recorderKey,
      savedWebsiteName,
      setIsLiveConfirmed,
      setIsNamingProject,
      setIsRecording,
      setRecorderKey,
      setWebsiteDraft,
      stepIndex,
      websiteDraft: activeWebsiteDraft,
      websiteId,
      workspaceName,
      setWebsiteId,
    }),
    [
      accountWorkspaceId,
      act,
      beginPreviewCut,
      direction,
      editingWebsiteId,
      editingWebsiteOrigin,
      emptyProjectId,
      visibleFaviconUrl,
      isFirstPaint,
      isFirstWebsite,
      isCameraOnProject,
      isLeaving,
      isRecording,
      isLiveConfirmed,
      installTargetId,
      journeyDomain,
      journeyOrigins,
      pollTick,
      registerStatusPoll,
      setInstallTargetId,
      previewProjectLabel,
      projectId,
      recorderKey,
      savedWebsiteName,
      stepIndex,
      activeWebsiteDraft,
      websiteId,
      workspaceName,
    ],
  );

  function goBack(): void {
    const previousStep = ONBOARDING_STEPS[Math.max(0, stepIndex - 1)];
    if (previousStep === undefined) return;
    void navigate({
      to: `/onboarding/$projectId/${previousStep}`,
      params: { projectId },
      search: websiteId === null ? {} : { website: websiteId },
      replace: true,
    });
  }

  return (
    <OnboardingFrame
      isLeaving={isLeaving}
      onBack={goBack}
      onboarding={onboarding}
      railFrom={railFrom}
      railSpan={railSpan}
      railTo={railTo}
      reduceMotion={reduceMotion}
      stepIndex={stepIndex}
    />
  );
}

type OnboardingFrameProps = {
  isLeaving: boolean;
  onBack: () => void;
  onboarding: ComponentProps<typeof OnboardingProvider>["value"];
  railFrom: number;
  railSpan: number;
  railTo: number;
  reduceMotion: boolean;
  stepIndex: number;
};

/** Persistent visual frame around the three routed onboarding steps. */
function OnboardingFrame({
  isLeaving,
  onBack,
  onboarding,
  railFrom,
  railSpan,
  railTo,
  reduceMotion,
  stepIndex,
}: OnboardingFrameProps) {
  return (
    <OnboardingProvider value={onboarding}>
      <main
        className="onboarding-shell grid min-h-svh grid-cols-1 overflow-hidden bg-background text-foreground lg:grid-cols-[51.9%_48.1%]"
        data-leaving={isLeaving ? "true" : "false"}
      >
        <m.section
          animate={{ opacity: isLeaving ? 0 : 1, x: isLeaving ? PREVIEW_EXIT.columnX : 0 }}
          className="relative min-h-svh bg-card lg:border-r lg:border-border"
          initial={false}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: PREVIEW_EXIT.columnDuration / 1_000, ease: PREVIEW_EXIT.ease }
          }
        >
          <div className="absolute top-6 left-6 flex items-center gap-2.5 text-[13px] font-medium">
            <BrandMark className="size-6" />
            <span>Orange Replay</span>
          </div>

          <div className="absolute top-[20svh] left-1/2 w-[min(394px,calc(100%-3rem))] -translate-x-1/2 max-lg:top-[19svh]">
            {/* Back sits on the form column's own leading edge, directly above
                the rail: a backwards move belongs at the start of the reading
                direction, next to the content it moves, not in the far corner
                opposite the brand. */}
            {stepIndex > 0 && (
              <Button
                className="absolute -top-9 left-0 h-7 px-2 text-[13px]"
                leadingIcon={ArrowLeft}
                onClick={onBack}
                type="button"
                variant="ghost"
              >
                Back
              </Button>
            )}

            {/* One unbroken lattice; how far the amber reaches is the whole
                statement, and the step count is in the label. Geometry and the
                travelling light live in `onboarding.css` under THE STEP RAIL —
                all it needs from here is where this run starts and ends.

                The run covers new ground only: nothing to the opened step at
                first paint, and the new stretch on a step change. `railSpan` is
                what the light is paid for, so the edge travels at one speed
                however far it has to go. Keys restart the animations; a finished
                one holds its end frame and would otherwise jump. */}
            <div
              aria-label={`Step ${stepIndex + 1} of ${ONBOARDING_STEPS.length}`}
              aria-valuemax={ONBOARDING_STEPS.length}
              aria-valuemin={1}
              aria-valuenow={stepIndex + 1}
              className="onboarding-step-rail"
              data-direction={railTo < railFrom ? "back" : "forward"}
              role="progressbar"
              style={
                {
                  height: RAIL.height,
                  "--step-from": railFrom,
                  "--step-to": railTo,
                  "--step-span": railSpan,
                } as CSSProperties
              }
            >
              {/* Near row and far row are separate because only the near row
                  glows, and a filter covers a whole element. */}
              <span aria-hidden className="onboarding-step-rail-fill" key={`fill-${stepIndex}`} />
              <span
                aria-hidden
                className="onboarding-step-rail-fill-far"
                key={`fill-far-${stepIndex}`}
              />
              {/* The light crosses both lattice rows and only the near one
                  blooms — a filter covers a whole element, so the far row needs
                  one of its own. */}
              <i aria-hidden className="onboarding-step-rail-light" key={`near-${stepIndex}`} />
              <i aria-hidden className="onboarding-step-rail-light-far" key={`far-${stepIndex}`} />
              {/* Individual cells inside the reached part, lighting on their own
                  timing. Canvas, because a repeating background has no cell to
                  select — see step-rail-twinkle.tsx. */}
              <StepRailTwinkle
                geometry={{
                  cell: RAIL.cell,
                  delay: RAIL.delay,
                  duration: railSpan * RAIL.speed,
                  from: railFrom,
                  pitch: RAIL.pitch,
                  to: railTo,
                }}
                key={`twinkle-${stepIndex}`}
              />
            </div>

            {/* This frame persists across step changes, so it — not the step —
                owns the height tween between screens of different lengths.
                A size layout animation needs the projection features, which the
                app-wide MotionProvider does not load (it ships `domAnimation`),
                so this subtree loads `domMax` the same way the top nav does for
                its notch. Without it the prop is silently inert.

                `layoutDependency` pins the re-measure to step changes. Without
                it every commit inside a step re-ran the projection — switching
                stack tabs on the install step swaps a TabPanel mid-commit, and
                the frame answered a same-height swap with a visible scale
                bounce. In-step growth is CSS-driven (the code card's t-resize),
                which never re-renders, so it never needed this animation. */}
            <LazyMotion features={domMax}>
              <m.div
                className="pt-7"
                layout={reduceMotion ? false : "size"}
                layoutDependency={stepIndex}
                transition={reduceMotion ? { duration: 0 } : FRAME.spring}
              >
                <Outlet />
              </m.div>
            </LazyMotion>
          </div>

          <p className="absolute bottom-5 left-6 text-[12px] text-dim">© Orange Replay 2026</p>
        </m.section>

        {/* The pane clips the frame at rest. Variant B's cut has the frame grow
            past every edge of it, so the clip is lifted for the duration and the
            pane is raised over the form column it is covering. */}
        <section
          aria-label="Your dashboard"
          className="onboarding-pane relative min-h-svh min-w-0 overflow-hidden max-lg:hidden"
        >
          <OnboardingPreview />
        </section>
      </main>
    </OnboardingProvider>
  );
}
