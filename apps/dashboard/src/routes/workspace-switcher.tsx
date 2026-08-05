import { type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { WebsiteFavicon } from "@/components/website-favicon";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { type AccountResponse } from "@/lib/api";
import { Global } from "@/lib/icon-map";
import { websiteFaviconUrl } from "@/lib/website-identity";

const ADD_WEBSITE_ACTION = "add:website";

/**
 * Website identity and creation controls in the dashboard header.
 *
 * `AppShell` owns the surrounding chrome. This component owns the complete
 * switcher interaction so its options, action row, favicon mapping, and
 * navigation cannot keep expanding the shell used by every route.
 *
 * The menu speaks the product's one container noun: Websites. Adding a
 * website always enters onboarding, where the domain itself decides whether
 * it joins the current visitor journey or starts its own.
 */
export function WorkspaceSwitcher({
  account,
  isDemo,
  projectId,
  projectLabel,
  projectLeadingContent,
}: {
  account: AccountResponse | undefined;
  isDemo: boolean;
  projectId: string;
  projectLabel?: string;
  projectLeadingContent?: ReactNode;
}) {
  const navigate = useNavigate();
  const accountWebsiteOptions = isDemo
    ? [{ id: projectId, label: "Landing page", websiteOrigin: null }]
    : (account?.workspaces.flatMap((workspace) =>
        workspace.projects.map((project) => ({
          id: project.id,
          label: readWebsiteLabel(project),
          websiteOrigin: project.websiteOrigin ?? null,
        })),
      ) ?? [{ id: projectId, label: "New website", websiteOrigin: null }]);
  const websiteOptions =
    projectLabel === undefined
      ? accountWebsiteOptions
      : accountWebsiteOptions.map((website) =>
          website.id === projectId ? { ...website, label: projectLabel } : website,
        );
  const activeWebsiteOption = websiteOptions.find((website) => website.id === projectId);
  const leadingContent = projectLeadingContent ?? (
    <WebsiteFavicon
      fallbackLabel={activeWebsiteOption?.label ?? "Website"}
      source={readWebsiteFaviconSource(activeWebsiteOption?.websiteOrigin)}
    />
  );
  const activeAccountWorkspace = account?.workspaces.find((workspace) =>
    workspace.projects.some((project) => project.id === projectId),
  );
  const canAddWebsite =
    !isDemo &&
    projectLabel === undefined &&
    (activeAccountWorkspace?.role === "owner" || activeAccountWorkspace?.role === "admin");

  function handleValueChange(value: string): void {
    if (value === ADD_WEBSITE_ACTION) {
      void navigate({
        to: "/onboarding/$projectId/website",
        params: { projectId },
      });
      return;
    }
    if (isDemo) {
      void navigate({ to: "/demo/overview" });
      return;
    }
    void navigate({
      to: "/projects/$projectId/overview",
      params: { projectId: value },
    });
  }

  return (
    <Select onValueChange={handleValueChange} value={projectId}>
      <SelectTrigger
        aria-label="Website"
        className="h-7.5 min-w-33 bg-transparent rounded-lg border-none hover:bg-secondary px-2.75 py-1.25 text-[12.5px] hover:text-foreground text-muted-foreground"
        /* The onboarding camera rings this control in amber when it is about
           to say the visitor's Website name. The dedicated hook keeps that
           visual contract independent from its accessible label. */
        data-shell-switcher=""
        leadingContent={leadingContent}
        placeholder="Website"
      />
      <SelectContent className="rounded-lg border border-border bg-popover">
        <SelectGroup>
          <SelectLabel>Websites</SelectLabel>
          {websiteOptions.map((website, index) => (
            <SelectItem
              index={index}
              key={website.id}
              leadingContent={
                <WebsiteFavicon
                  fallbackLabel={website.label}
                  source={readWebsiteFaviconSource(website.websiteOrigin)}
                />
              }
              value={website.id}
            >
              {website.label}
            </SelectItem>
          ))}
        </SelectGroup>
        {canAddWebsite && (
          <>
            <SelectSeparator />
            <SelectItem icon={Global} index={websiteOptions.length} value={ADD_WEBSITE_ACTION}>
              Add website
            </SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

function readWebsiteLabel(project: { id: string; name: string }): string {
  const name = project.name.trim();
  return name.length === 0 || name === "Default project" || name === project.id
    ? "New website"
    : name;
}

function readWebsiteFaviconSource(origin: string | null | undefined): string | null {
  return origin === null || origin === undefined ? null : websiteFaviconUrl(new URL(origin));
}
