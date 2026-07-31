import { createContext, use, type ReactNode } from "react";
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

/** Fraction of the flow completed once a step is on screen. */
export function onboardingProgress(stepIndex: number): number {
  return (stepIndex + 1) / ONBOARDING_STEPS.length;
}

interface OnboardingState {
  /** Signed-in project being activated. */
  projectId: string;
  /** Raw text in the website field, kept while moving between steps. */
  websiteDraft: string;
  setWebsiteDraft: (value: string) => void;
  /** Project name already saved for this project, or null before activation. */
  savedWebsiteName: string | null;
  /** Raw recorder key minted this visit. Never re-readable after a reload. */
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
  /** The act driving the preview. Derived, never set directly. */
  act: OnboardingAct;
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
