import type { FormEvent } from "react";
import type { ProjectWebsite } from "@orange-replay/shared";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Check } from "@/lib/icon-map";
import { useOnboarding } from "./onboarding-context";
import { OnboardingStage } from "./onboarding-stage";

/**
 * A calm recovery state for an origin that is already installed. The user sees
 * the Website outcome; the existing internal key stays completely invisible.
 */
export function OnboardingConnectedWebsite({
  onAddAnother,
  website,
}: {
  onAddAnother: () => void;
  website: ProjectWebsite;
}) {
  const navigate = useNavigate();
  const {
    projectId,
    setIsNamingProject,
    setRecorderKey,
    setWebsiteDraft,
    setWebsiteId,
    workspaceName,
  } = useOnboarding();
  const workspaceDescription =
    workspaceName === null || workspaceName === website.name
      ? "This website is already connected."
      : `This website is already connected alongside ${workspaceName}.`;

  function openDashboard(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void navigate({
      to: "/projects/$projectId/overview",
      params: { projectId },
      replace: true,
    });
  }

  function addAnotherWebsite(): void {
    setIsNamingProject(false);
    setRecorderKey(null);
    setWebsiteDraft("");
    setWebsiteId(null);
    onAddAnother();
  }

  return (
    <OnboardingStage
      action={
        <div className="flex flex-col gap-2">
          <Button className="w-full" size="lg" type="submit">
            Go to dashboard
          </Button>
          <Button className="w-full" onClick={addAnotherWebsite} type="button" variant="ghost">
            Add another website
          </Button>
        </div>
      }
      body={
        <div
          aria-live="polite"
          className="flex min-h-20.5 items-start gap-3 rounded-lg border border-border bg-secondary p-3.5"
          role="status"
        >
          <span
            aria-hidden
            className="mt-0.5 grid size-4.5 shrink-0 place-items-center rounded-full bg-success/15 shadow-[0_0_0_4px_color-mix(in_oklab,var(--success)_10%,transparent)]"
          >
            <Check className="text-success" size={11} strokeWidth={2} />
          </span>
          <div>
            <strong className="text-[13px] font-medium text-foreground">No changes needed</strong>
            <p className="mt-1 text-[12px] leading-[17px] text-muted-foreground">
              No new installation was created. The existing script will keep recording.
            </p>
          </div>
        </div>
      }
      heading={`${website.name} is already connected`}
      onSubmit={openDashboard}
      support={workspaceDescription}
    />
  );
}
