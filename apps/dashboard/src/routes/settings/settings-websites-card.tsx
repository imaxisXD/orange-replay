import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { WebsiteFavicon } from "@/components/website-favicon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";
import {
  accountQueryKey,
  ensureProjectWebsite,
  fetchProjectWebsites,
  projectWebsitesQueryKey,
} from "@/lib/api";
import { AlertCircle, Global, RotateCcw } from "@/lib/icon-map";
import { websiteFaviconUrl } from "@/lib/website-identity";
import { TIMING } from "@/routes/onboarding/onboarding-motion";
import { saveOnboardingRecorderKey } from "@/routes/onboarding/onboarding-recorder-key";
import { readWebsiteSetupError } from "@/routes/onboarding/onboarding-setup-error";
import { readWebsiteUrl, websiteUrlError } from "@/routes/onboarding/onboarding-website";
import { SettingsCard, SettingsLoading } from "./settings-fields";

const FAVICON_DELAY_MS = 250;

export function WebsitesCard({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [websiteDraft, setWebsiteDraft] = useState("");
  const [showFieldError, setShowFieldError] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const websiteUrl = readWebsiteUrl(websiteDraft);
  const expectedFaviconUrl = websiteUrl === null ? null : websiteFaviconUrl(websiteUrl);
  const visibleFaviconUrl = faviconUrl === expectedFaviconUrl ? faviconUrl : null;
  const websitesQuery = useQuery({
    queryKey: projectWebsitesQueryKey(projectId),
    queryFn: () => fetchProjectWebsites(projectId),
    staleTime: 30_000,
  });

  useEffect(() => {
    setFaviconUrl((current) => (current === expectedFaviconUrl ? current : null));
    if (expectedFaviconUrl === null) return;
    const timeout = window.setTimeout(() => setFaviconUrl(expectedFaviconUrl), FAVICON_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [expectedFaviconUrl]);

  useEffect(() => {
    if (websiteDraft.trim().length === 0 || websiteUrl !== null) {
      setShowFieldError(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowFieldError(true), TIMING.websiteValidation);
    return () => window.clearTimeout(timeout);
  }, [websiteDraft, websiteUrl]);

  const addWebsite = useMutation({
    mutationFn: (url: URL) => ensureProjectWebsite(projectId, url.href),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: projectWebsitesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: accountQueryKey });
      if (result.alreadyConnected || result.secret === null) {
        setRequestError("That website is already part of this Workspace.");
        return;
      }
      saveOnboardingRecorderKey(projectId, result.website.id, result.secret);
      void navigate({
        to: "/onboarding/$projectId/install",
        params: { projectId },
        search: { website: result.website.id },
      });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setRequestError("");
    if (websiteUrl === null) {
      setShowFieldError(true);
      return;
    }
    addWebsite.mutate(websiteUrl);
  }

  if (websitesQuery.isPending) return <SettingsLoading />;
  if (websitesQuery.isError || websitesQuery.data === undefined) {
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden />
        <AlertTitle>Could not load Websites</AlertTitle>
        <AlertDescription>
          <p>Website settings could not be loaded.</p>
          <Button
            className="mt-2 border-danger-border bg-transparent text-danger-foreground hover:text-foreground"
            leadingIcon={RotateCcw}
            onClick={() => void websitesQuery.refetch()}
            size="sm"
            variant="secondary"
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const fieldError = showFieldError ? websiteUrlError(websiteDraft) : "";
  const mutationError =
    addWebsite.error === null
      ? ""
      : readWebsiteSetupError(addWebsite.error, "Could not add this website. Try again.");

  return (
    <SettingsCard
      body="Websites in this Workspace share one visitor journey."
      className="flex flex-col"
      title="Websites"
    >
      <>
        {websitesQuery.data.websites.length === 0 ? (
          <div className="px-4 py-5 text-[13px] text-muted-foreground">
            No websites have been added yet.
          </div>
        ) : (
          websitesQuery.data.websites.map((website) => (
            <div className="flex items-center gap-3 px-4 py-3.5" key={website.id}>
              <WebsiteFavicon
                fallbackLabel={website.name}
                source={websiteFaviconUrl(new URL(website.origin))}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{website.name}</div>
                <div className="mt-1 truncate font-mono text-[11.5px] text-muted-foreground">
                  {website.origin}
                </div>
              </div>
              <Badge
                color={website.firstEventAt === null ? "amber" : "green"}
                size="sm"
                variant="dot"
              >
                {website.firstEventAt === null ? "Setup needed" : "Connected"}
              </Badge>
              {website.firstEventAt === null && (
                <Button
                  onClick={() =>
                    void navigate({
                      to: "/onboarding/$projectId/website",
                      params: { projectId },
                      search: { website: website.id },
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  Continue setup
                </Button>
              )}
            </div>
          ))
        )}

        <form className="px-4 py-4" onSubmit={handleSubmit}>
          <div className="mb-3">
            <div className="text-[13px] font-medium">Add another website</div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Enter its address, then continue to the installation script.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <InputGroup className="min-w-0 flex-1 gap-0">
              <InputField
                animateError
                autoComplete="url"
                error={fieldError}
                index={0}
                inputMode="url"
                label="Website URL"
                onChange={(value) => {
                  setWebsiteDraft(value);
                  setShowFieldError(false);
                  setRequestError("");
                  addWebsite.reset();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
                placeholder="example.com"
                startContent={
                  <WebsiteFavicon
                    fallbackLabel={websiteUrl?.hostname ?? websiteDraft}
                    source={visibleFaviconUrl}
                  />
                }
                type="text"
                value={websiteDraft}
              />
            </InputGroup>
            <Button
              className="sm:mt-5"
              disabled={websiteDraft.trim().length === 0}
              leadingIcon={Global}
              loading={addWebsite.isPending}
              size="sm"
              type="submit"
              variant="secondary"
            >
              Continue to install
            </Button>
          </div>
          {(requestError || mutationError).length > 0 && (
            <p className="mt-2 text-[12px] text-danger" role="alert">
              {requestError || mutationError}
            </p>
          )}
        </form>
      </>
    </SettingsCard>
  );
}
