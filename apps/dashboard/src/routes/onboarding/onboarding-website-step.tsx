import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { accountQueryKey, fetchProjectConfig, renameProject, saveProjectConfig } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { readDashboardAccessError } from "@/lib/dashboard-access";
import { ONBOARDING_STEP_PATHS, useOnboarding } from "./onboarding-context";
import { TIMING } from "./onboarding-motion";
import { OnboardingStage } from "./onboarding-stage";
import {
  activationAllowedOrigins,
  readWebsiteUrl,
  websiteProjectName,
  websiteUrlError,
} from "./onboarding-website";

/**
 * Step 1 of 3 — the website being recorded.
 *
 * One URL settles three things at once: the project's name, the favicon
 * identity shown in the switcher, and the origins ingest will accept. A
 * bootstrapped project starts with an empty origin allowlist, which the ingest
 * path treats as "allow nothing", so this step is what makes the project able
 * to record at all.
 */
export function OnboardingWebsitePage() {
  const navigate = useNavigate();
  const { projectId, setIsNamingProject, setWebsiteDraft, websiteDraft } = useOnboarding();
  const [showError, setShowError] = useState(false);
  const [isShaking, setIsShaking] = useState(false);
  const websiteUrl = readWebsiteUrl(websiteDraft);
  const isReady = websiteUrl !== null;

  const activation = useMutation({
    mutationFn: async (url: URL) => {
      // Two writes, and they cannot be one transaction, so order them by what a
      // partial failure leaves behind. The allowlist is what lets the project
      // record at all; the name is cosmetic. Writing the allowlist first means a
      // failure after it leaves a project that works but is still called
      // "Default project" — recoverable by retrying, and the retry re-reads the
      // config so `expectedVersion` is fresh. The other order left a project
      // renamed to the visitor's website yet unable to ingest a single event,
      // which is the same state the flow exists to prevent.
      const config = await fetchProjectConfig(projectId);
      await saveProjectConfig(projectId, {
        allowedOrigins: activationAllowedOrigins(url),
        capture: config.capture,
        expectedVersion: config.version,
        maskPolicyVersion: config.maskPolicyVersion,
        maskRules: config.maskRules,
        retentionDays: config.retentionDays,
        sampleRate: config.sampleRate,
      });
      await renameProject(projectId, websiteProjectName(url));
      await queryClient.invalidateQueries({ queryKey: accountQueryKey });
    },
    onSuccess: () => {
      void navigate({ to: ONBOARDING_STEP_PATHS.install });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (websiteUrl === null) {
      setShowError(true);
      setIsShaking(true);
      window.setTimeout(() => setIsShaking(false), TIMING.shake);
      return;
    }
    activation.mutate(websiteUrl);
  }

  const fieldError = showError ? websiteUrlError(websiteDraft) : "";
  const requestError =
    activation.error === null
      ? ""
      : readDashboardAccessError(activation.error, "Could not save your website. Try again.");

  return (
    <OnboardingStage
      action={
        <div className="flex flex-col gap-2">
          <Button
            className="w-full"
            disabled={!isReady}
            loading={activation.isPending}
            size="lg"
            type="submit"
          >
            Continue
          </Button>
          {requestError.length > 0 && (
            <p className="text-[12px] text-danger" role="alert">
              {requestError}
            </p>
          )}
        </div>
      }
      body={
        <InputGroup className={`w-full gap-0 ${isShaking ? "onboarding-shake" : ""}`}>
          <InputField
            autoComplete="url"
            error={fieldError}
            index={0}
            inputMode="url"
            label="Website URL"
            onBlur={() => setIsNamingProject(false)}
            onChange={(value) => {
              setWebsiteDraft(value);
              setShowError(false);
              setIsNamingProject(value.trim().length > 0);
            }}
            onFocus={() => setIsNamingProject(websiteDraft.trim().length > 0)}
            placeholder="https://example.com"
            type="url"
            value={websiteDraft}
          />
        </InputGroup>
      }
      heading="Add your website"
      onSubmit={handleSubmit}
      support="Its address names your project and tells the recorder which pages to accept."
    />
  );
}

export default OnboardingWebsitePage;
