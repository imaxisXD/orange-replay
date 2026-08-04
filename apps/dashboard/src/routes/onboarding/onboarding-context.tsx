import { createContext, use, type ReactNode } from "react";
import type { InstallTargetId } from "./install-targets";
import type { OnboardingAct } from "./onboarding-motion";

/** The three activation screens, in order. Each one is its own route file. */
export const ONBOARDING_STEPS = ["website", "install", "verify"] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Step index from a pathname, clamped to the first step when unrecognised. */
export function onboardingStepIndex(pathname: string): number {
  const finalPathPart = pathname.replace(/\/+$/, "").split("/").at(-1);
  const index = ONBOARDING_STEPS.findIndex((step) => step === finalPathPart);
  return index === -1 ? 0 : index;
}

interface OnboardingState {
  /** Signed-in project being activated. */
  projectId: string;
  /** Display name of the current Workspace once it has a user-facing name. */
  workspaceName: string | null;
  /** True only while this Workspace has no saved Website. */
  isFirstWebsite: boolean;
  /** Raw text in the website field, kept while moving between steps. */
  websiteDraft: string;
  setWebsiteDraft: (value: string) => void;
  /** Website being installed inside the Workspace. */
  websiteId: string | null;
  setWebsiteId: (value: string | null) => void;
  /** Unfinished Website being edited after the visitor chose Back. */
  editingWebsiteId: string | null;
  /** Saved origin used to tell a real edit from simply moving forward again. */
  editingWebsiteOrigin: string | null;
  /** Project name already saved for this project, or null before activation. */
  savedWebsiteName: string | null;
  /** Internal installation key returned for this Website. Kept in this tab until connection. */
  recorderKey: string | null;
  setRecorderKey: (value: string | null) => void;
  /** True while the website field holds focus with something typed in it. */
  isNamingProject: boolean;
  setIsNamingProject: (value: boolean) => void;
  /**
   * True once the project has recorded its first event. Reported up from the
   * verify step so the right pane can respond: the steps are routes and cannot
   * see each other, so the shell is the only place that can hold the act.
   */
  isRecording: boolean;
  setIsRecording: (value: boolean) => void;
  /**
   * True once the live query has returned the session the first event started.
   * `isRecording` walks the preview to the Live page; this fills its card. The
   * two are separate because they are true at different moments — the event
   * lands seconds before the session surfaces on Live, and a "Live now" badge
   * shown in that gap would be claiming something the real page cannot show yet.
   */
  isLiveConfirmed: boolean;
  setIsLiveConfirmed: (value: boolean) => void;
  /** The act driving the preview. Derived, never set directly. */
  act: OnboardingAct;
  /**
   * Counts completed install-status polls. The preview rings once per tick, so
   * this has to be a count: a boolean would ring once and then be true forever.
   */
  pollTick: number;
  registerStatusPoll: () => void;
  /**
   * Step two's stack choice, held here because the preview mirrors it and the
   * two are on opposite sides of a route boundary.
   */
  installTargetId: InstallTargetId;
  setInstallTargetId: (value: InstallTargetId) => void;
  /**
   * True once the exit's cut has started. The shell owns it because the grow
   * has to outlive the step that triggered it and take the form column with it.
   */
  isLeaving: boolean;
  beginPreviewCut: () => void;
  /** Label the dashboard preview shows in its project switcher. */
  previewProjectLabel: string;
  /** Debounced same-origin favicon endpoint for the current valid website. */
  faviconUrl: string | null;
  /** Step currently on screen, and which way the last move travelled. */
  stepIndex: number;
  direction: 1 | -1;
  /** True until the first step change, so the opening reveal can lead in. */
  isFirstPaint: boolean;
}

const OnboardingContext = createContext<OnboardingState | null>(null);

export function OnboardingProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: OnboardingState;
}) {
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingState {
  const context = use(OnboardingContext);
  if (context === null) {
    throw new Error("Onboarding steps must render inside the onboarding shell.");
  }
  return context;
}
