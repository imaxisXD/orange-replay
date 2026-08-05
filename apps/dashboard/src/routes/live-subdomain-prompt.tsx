import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  accountQueryKey,
  fetchAccount,
  fetchProjectWebsites,
  projectWebsitesQueryKey,
} from "@/lib/api";
import { canManageProject, findAccountProject } from "@/lib/dashboard-access";
import { Global } from "@/lib/icon-map";

const DISMISSED_PREFIX = "orange-replay:subdomain-prompt:";

/**
 * One-time nudge after activation. Every Website keeps an exact origin and its
 * own recorder key, while related HTTPS subdomains share visitor identity once
 * they are added. Shown to owners and admins while the project records exactly
 * one connected Website, until dismissed for that project.
 */
export function LiveSubdomainPrompt({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [dismissedProjectId, setDismissedProjectId] = useState<string | null>(null);
  const dismissed = dismissedProjectId === projectId || readDismissed(projectId);
  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: fetchAccount,
    staleTime: 30_000,
  });
  const project = findAccountProject(accountQuery.data, projectId);
  const canManage = canManageProject(project);
  const websitesQuery = useQuery({
    queryKey: projectWebsitesQueryKey(projectId),
    queryFn: () => fetchProjectWebsites(projectId),
    enabled: !dismissed && canManage,
    staleTime: 30_000,
  });

  const websites = websitesQuery.data?.websites;
  const onlyWebsite = websites?.length === 1 ? websites[0] : undefined;
  if (dismissed || !canManage || onlyWebsite === undefined || onlyWebsite.firstEventAt === null) {
    return null;
  }

  const route = readWebsiteRoute(onlyWebsite.origin, project?.journeyDomain);
  if (route === null) return null;

  function dismiss(): void {
    setDismissedProjectId(projectId);
    try {
      window.localStorage.setItem(`${DISMISSED_PREFIX}${projectId}`, "1");
    } catch {
      // State alone hides it for this visit when storage is unavailable.
    }
  }

  return (
    <Alert>
      <Global aria-hidden />
      <AlertTitle>Record the next subdomain</AlertTitle>
      <AlertDescription>
        <p>
          If visitors continue to {route.suggestion}, add it as another website and install its
          snippet there. Both websites stay in the same visitor journey.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <Button
            onClick={() =>
              void navigate({
                to: "/onboarding/$projectId/website",
                params: { projectId },
                search: { draft: `https://${route.suggestion}` },
              })
            }
            size="sm"
            variant="secondary"
          >
            Add website
          </Button>
          <Button onClick={dismiss} size="sm" variant="ghost">
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function readDismissed(projectId: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISSED_PREFIX}${projectId}`) === "1";
  } catch {
    return false;
  }
}

function readWebsiteRoute(
  origin: string,
  journeyDomain: string | null | undefined,
): { suggestion: string } | null {
  if (journeyDomain === undefined || journeyDomain === null) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return null;
    const domain = journeyDomain.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) return null;
    const displayHostname = hostname.replace(/^www\./i, "");
    return { suggestion: displayHostname === domain ? `app.${domain}` : domain };
  } catch {
    return null;
  }
}
