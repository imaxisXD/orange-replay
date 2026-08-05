import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { WebsiteFavicon } from "@/components/website-favicon";
import {
  accountQueryKey,
  createProject,
  ensureProjectWebsite,
  projectWebsitesQueryKey,
} from "@/lib/api";
import { queryClient } from "@/lib/query";
import { useOnboarding } from "./onboarding-context";
import { TIMING } from "./onboarding-motion";
import {
  readWebsiteSetupError,
  WEBSITE_DESTINATION_MISSING_MESSAGE,
  WEBSITE_JOURNEY_LOADING_MESSAGE,
} from "./onboarding-setup-error";
import { OnboardingStage } from "./onboarding-stage";
import { OnboardingConnectedWebsite } from "./onboarding-connected-website";
import {
  canDecideVisitorJourney,
  continuesVisitorJourney,
  readWebsiteUrl,
  websiteFaviconUrl,
  websiteUrlError,
} from "./onboarding-website";
import { clearOnboardingRecorderKey, saveOnboardingRecorderKey } from "./onboarding-recorder-key";

/**
 * Step 1 of 3 — the website being recorded.
 *
 * The Worker owns this boundary: it creates or reuses one Website installation
 * inside the current Workspace, then returns the setup needed by the next step.
 */
export function OnboardingWebsitePage() {
  const navigate = useNavigate();
  const {
    accountWorkspaceId,
    editingWebsiteId,
    editingWebsiteOrigin,
    emptyProjectId,
    faviconUrl,
    isFirstWebsite,
    journeyDomain,
    journeyOrigins,
    previewProjectLabel,
    projectId,
    setIsNamingProject,
    setRecorderKey,
    setWebsiteId,
    setWebsiteDraft,
    websiteDraft,
  } = useOnboarding();
  const [showError, setShowError] = useState(false);
  const [connectedWebsite, setConnectedWebsite] = useState<
    Awaited<ReturnType<typeof ensureProjectWebsite>>["website"] | null
  >(null);
  const inputGroupRef = useRef<HTMLDivElement>(null);
  const shakeFrameRef = useRef<number | null>(null);
  const shakeEndRef = useRef<number | null>(null);
  const separateWebsiteProjectIdRef = useRef<string | null>(emptyProjectId);
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
    mutationFn: async (url: URL) => {
      if (editingWebsiteId !== null) {
        return {
          targetProjectId: projectId,
          ...(await ensureProjectWebsite(projectId, url.href, editingWebsiteId)),
        };
      }
      // A domain outside this visitor journey records on its own: it gets a
      // reusable empty project, or a fresh project, so its sessions and
      // cookies never pool with an unrelated site. Related subdomains keep
      // landing in this journey.
      if (!isFirstWebsite && !canDecideVisitorJourney(journeyOrigins, journeyDomain)) {
        throw new Error(WEBSITE_JOURNEY_LOADING_MESSAGE);
      }
      if (!isFirstWebsite && !continuesVisitorJourney(url, journeyOrigins, journeyDomain)) {
        if (accountWorkspaceId === null) {
          throw new Error(WEBSITE_DESTINATION_MISSING_MESSAGE);
        }
        let targetProjectId = separateWebsiteProjectIdRef.current ?? emptyProjectId;
        if (targetProjectId === null) {
          const created = await createProject(accountWorkspaceId);
          targetProjectId = created.project.id;
          separateWebsiteProjectIdRef.current = targetProjectId;
          queryClient.setQueryData(accountQueryKey, created.account);
        }
        return {
          targetProjectId,
          ...(await ensureProjectWebsite(targetProjectId, url.href)),
        };
      }
      return { targetProjectId: projectId, ...(await ensureProjectWebsite(projectId, url.href)) };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: projectWebsitesQueryKey(result.targetProjectId),
      });
      if (result.alreadyConnected || result.secret === null) {
        clearOnboardingRecorderKey(result.targetProjectId, result.website.id);
        setRecorderKey(null);
        setWebsiteDraft(result.website.origin);
        setWebsiteId(result.website.id);
        setConnectedWebsite(result.website);
        return;
      }
      saveOnboardingRecorderKey(result.targetProjectId, result.website.id, result.secret);
      setRecorderKey(result.secret);
      void queryClient.invalidateQueries({ queryKey: accountQueryKey });
      continueToInstall(result.targetProjectId, result.website.id);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (websiteUrl === null) {
      revealWebsiteError();
      return;
    }
    if (
      editingWebsiteId !== null &&
      editingWebsiteOrigin !== null &&
      websiteUrl.origin === editingWebsiteOrigin
    ) {
      activation.reset();
      continueToInstall(projectId, editingWebsiteId);
      return;
    }
    activation.mutate(websiteUrl);
  }

  function continueToInstall(targetProjectId: string, nextWebsiteId: string): void {
    setWebsiteId(nextWebsiteId);
    void navigate({
      to: "/onboarding/$projectId/install",
      params: { projectId: targetProjectId },
      search: { website: nextWebsiteId },
    });
  }

  const fieldError = showError ? websiteUrlError(websiteDraft) : "";
  const requestError =
    activation.error === null
      ? ""
      : readWebsiteSetupError(
          activation.error,
          editingWebsiteId === null
            ? "Could not add this website. Try again."
            : "Could not save this website. Try again.",
        );

  if (connectedWebsite !== null) {
    return (
      <OnboardingConnectedWebsite
        onAddAnother={() => setConnectedWebsite(null)}
        website={connectedWebsite}
      />
    );
  }

  // The destination is decided by the domain itself (subdomains continue this
  // journey, new domains start their own), so the heading no longer promises
  // one container.
  const heading =
    editingWebsiteId !== null
      ? "Edit website"
      : isFirstWebsite
        ? "Add your first website"
        : "Add a website";
  const support =
    editingWebsiteId !== null
      ? "Update the website you want Orange Replay to record."
      : isFirstWebsite
        ? "Enter the website where you want to start recording."
        : "Add related subdomains to keep one visitor journey. A new domain gets its own recordings.";

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
            {editingWebsiteId === null ? "Continue" : "Save and continue"}
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
      heading={heading}
      onSubmit={handleSubmit}
      support={support}
    />
  );
}

export default OnboardingWebsitePage;
