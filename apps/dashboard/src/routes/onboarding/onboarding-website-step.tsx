import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { accountQueryKey, ensureProjectWebsite } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { readDashboardAccessError } from "@/lib/dashboard-access";
import { useOnboarding } from "./onboarding-context";
import { TIMING } from "./onboarding-motion";
import { OnboardingStage } from "./onboarding-stage";
import { readWebsiteUrl, websiteFaviconUrl, websiteUrlError } from "./onboarding-website";
import { WebsiteFavicon } from "./website-favicon";
import { saveOnboardingRecorderKey } from "./onboarding-recorder-key";

/**
 * Step 1 of 3 — the website being recorded.
 *
 * The Worker owns this boundary: it creates or reuses one Website and one
 * recorder key inside the current Workspace, then returns the recoverable key
 * needed by the next step.
 */
export function OnboardingWebsitePage() {
  const navigate = useNavigate();
  const {
    faviconUrl,
    previewProjectLabel,
    projectId,
    setIsNamingProject,
    setRecorderKey,
    setWebsiteId,
    setWebsiteDraft,
    websiteDraft,
  } = useOnboarding();
  const [showError, setShowError] = useState(false);
  const inputGroupRef = useRef<HTMLDivElement>(null);
  const shakeFrameRef = useRef<number | null>(null);
  const shakeEndRef = useRef<number | null>(null);
  const websiteUrl = readWebsiteUrl(websiteDraft);
  const hasInvalidWebsite = websiteDraft.trim().length > 0 && websiteUrl === null;
  const expectedFaviconUrl = websiteUrl === null ? null : websiteFaviconUrl(websiteUrl);
  const inputFaviconUrl = faviconUrl === expectedFaviconUrl ? faviconUrl : null;

  const stopErrorShake = useCallback(() => {
    if (shakeFrameRef.current !== null) window.cancelAnimationFrame(shakeFrameRef.current);
    if (shakeEndRef.current !== null) window.clearTimeout(shakeEndRef.current);
    shakeFrameRef.current = null;
    shakeEndRef.current = null;
    inputGroupRef.current?.querySelector(".t-input")?.classList.remove("is-shaking");
  }, []);

  const clearWebsiteError = useCallback(() => {
    setShowError(false);
    stopErrorShake();
  }, [stopErrorShake]);

  const revealWebsiteError = useCallback(() => {
    setShowError(true);
    stopErrorShake();
    shakeFrameRef.current = window.requestAnimationFrame(() => {
      shakeFrameRef.current = null;
      const input = inputGroupRef.current?.querySelector(".t-input");
      if (!(input instanceof HTMLElement)) return;

      input.classList.remove("is-shaking");
      void input.offsetWidth;
      input.classList.add("is-shaking");

      const styles = window.getComputedStyle(input);
      const duration = (name: string, fallback: number) => {
        const value = Number.parseFloat(styles.getPropertyValue(name));
        return Number.isFinite(value) ? value : fallback;
      };
      const shakeDuration = duration("--shake-dur-a", 80) * 2 + duration("--shake-dur-b", 60) * 2;
      shakeEndRef.current = window.setTimeout(() => {
        input.classList.remove("is-shaking");
        shakeEndRef.current = null;
      }, shakeDuration + 20);
    });
  }, [stopErrorShake]);

  useEffect(() => {
    if (!hasInvalidWebsite) return;
    const timeout = window.setTimeout(revealWebsiteError, TIMING.websiteValidation);
    return () => window.clearTimeout(timeout);
  }, [hasInvalidWebsite, revealWebsiteError, websiteDraft]);

  useEffect(() => stopErrorShake, [stopErrorShake]);

  const activation = useMutation({
    mutationFn: (url: URL) => ensureProjectWebsite(projectId, url.href),
    onSuccess: (result) => {
      if (result.alreadyConnected || result.secret === null) {
        void navigate({
          to: "/projects/$projectId/overview",
          params: { projectId },
          replace: true,
        });
        return;
      }
      saveOnboardingRecorderKey(projectId, result.website.id, result.secret);
      setRecorderKey(result.secret);
      setWebsiteId(result.website.id);
      void queryClient.invalidateQueries({ queryKey: accountQueryKey });
      void navigate({
        to: "/onboarding/$projectId/install",
        params: { projectId },
        search: { website: result.website.id },
      });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (websiteUrl === null) {
      revealWebsiteError();
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
            disabled={websiteDraft.trim().length === 0}
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
        <InputGroup
          className={`t-input-wrap w-full gap-0 ${fieldError.length > 0 ? "is-error" : ""}`}
          ref={inputGroupRef}
        >
          <InputField
            animateError
            autoComplete="url"
            error={fieldError}
            index={0}
            inputMode="url"
            label="Website URL"
            containerClassName={`t-input ${fieldError.length > 0 ? "is-error" : ""}`}
            onBlur={() => setIsNamingProject(false)}
            onChange={(value) => {
              clearWebsiteError();
              setWebsiteDraft(value);
              setIsNamingProject(value.trim().length > 0);
            }}
            onFocus={() => setIsNamingProject(websiteDraft.trim().length > 0)}
            placeholder="example.com"
            startContent={
              <WebsiteFavicon fallbackLabel={previewProjectLabel} source={inputFaviconUrl} />
            }
            type="text"
            value={websiteDraft}
          />
        </InputGroup>
      }
      heading="Add your website"
      onSubmit={handleSubmit}
      support="This adds one Website to your Workspace and prepares its own recorder key."
    />
  );
}

export default OnboardingWebsitePage;
