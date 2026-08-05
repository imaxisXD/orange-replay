import { type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { ApiError, accountQueryKey, createProject, type AccountResponse } from "@/lib/api";
import { readDashboardAccessError } from "@/lib/dashboard-access";
import { Building, Global } from "@/lib/icon-map";
import { websiteFaviconUrl } from "@/lib/website-identity";

const ADD_WEBSITE_ACTION = "add:website";
const ADD_WORKSPACE_ACTION = "add:workspace";

/**
 * Workspace identity and creation controls in the dashboard header.
 *
 * `AppShell` owns the surrounding chrome. This component owns the complete
 * switcher interaction so its options, action rows, favicon mapping, navigation,
 * and create request cannot keep expanding the shell used by every route.
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
  const queryClient = useQueryClient();
  const accountWorkspaceOptions = isDemo
    ? [{ id: projectId, label: "Landing page", websiteOrigin: null }]
    : (account?.workspaces.flatMap((workspace) =>
        workspace.projects.map((project) => ({
          id: project.id,
          label: readWorkspaceLabel(project),
          websiteOrigin: project.websiteOrigin ?? null,
        })),
      ) ?? [{ id: projectId, label: "Your workspace", websiteOrigin: null }]);
  const workspaceOptions =
    projectLabel === undefined
      ? accountWorkspaceOptions
      : accountWorkspaceOptions.map((workspace) =>
          workspace.id === projectId ? { ...workspace, label: projectLabel } : workspace,
        );
  const activeWorkspaceOption = workspaceOptions.find((workspace) => workspace.id === projectId);
  const leadingContent = projectLeadingContent ?? (
    <WebsiteFavicon
      fallbackLabel={activeWorkspaceOption?.label ?? "Workspace"}
      source={readWebsiteFaviconSource(activeWorkspaceOption?.websiteOrigin)}
    />
  );
  const activeAccountWorkspace = account?.workspaces.find((workspace) =>
    workspace.projects.some((project) => project.id === projectId),
  );
  const canAddWorkspaceContent =
    !isDemo &&
    projectLabel === undefined &&
    (activeAccountWorkspace?.role === "owner" || activeAccountWorkspace?.role === "admin");
  const createWorkspace = useMutation({
    mutationFn: async () => {
      if (activeAccountWorkspace === undefined) {
        throw new Error("Could not find this project's workspace.");
      }
      return createProject(activeAccountWorkspace.id);
    },
    onSuccess: (created) => {
      queryClient.setQueryData(accountQueryKey, created.account);
      void navigate({
        to: "/onboarding/$projectId/website",
        params: { projectId: created.project.id },
      });
    },
  });
  const createWorkspaceError =
    createWorkspace.error === null ? "" : readCreateWorkspaceError(createWorkspace.error);

  function handleValueChange(value: string): void {
    if (value === ADD_WEBSITE_ACTION) {
      void navigate({
        to: "/onboarding/$projectId/website",
        params: { projectId },
      });
      return;
    }
    if (value === ADD_WORKSPACE_ACTION) {
      createWorkspace.mutate();
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
    <>
      <Select onValueChange={handleValueChange} value={projectId}>
        <SelectTrigger
          aria-label="Workspace"
          className="h-7.5 min-w-33 bg-transparent rounded-lg border-none hover:bg-secondary px-2.75 py-1.25 text-[12.5px] hover:text-foreground text-muted-foreground"
          /* The onboarding camera rings this control in amber when it is about
             to say the visitor's Website name. The dedicated hook keeps that
             visual contract independent from its accessible label. */
          data-shell-switcher=""
          leadingContent={leadingContent}
          placeholder="Workspace"
        />
        <SelectContent className="rounded-lg border border-border bg-popover">
          <SelectGroup>
            <SelectLabel>Workspaces</SelectLabel>
            {workspaceOptions.map((workspace, index) => (
              <SelectItem
                index={index}
                key={workspace.id}
                leadingContent={
                  <WebsiteFavicon
                    fallbackLabel={workspace.label}
                    source={readWebsiteFaviconSource(workspace.websiteOrigin)}
                  />
                }
                value={workspace.id}
              >
                {workspace.label}
              </SelectItem>
            ))}
          </SelectGroup>
          {canAddWorkspaceContent && (
            <>
              <SelectSeparator />
              <SelectItem icon={Global} index={workspaceOptions.length} value={ADD_WEBSITE_ACTION}>
                Add website
              </SelectItem>
              <SelectItem
                disabled={createWorkspace.isPending}
                icon={Building}
                index={workspaceOptions.length + 1}
                value={ADD_WORKSPACE_ACTION}
              >
                {createWorkspace.isPending ? "Adding workspace…" : "Add workspace"}
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>

      {createWorkspaceError.length > 0 && (
        <p className="max-w-52 text-[11.5px] text-danger" role="alert">
          {createWorkspaceError}
        </p>
      )}
    </>
  );
}

function readCreateWorkspaceError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Only a workspace owner or admin can add a workspace.";
    if (error.code === "network_error") return error.message;
    return "Could not add the workspace. Try again.";
  }
  return readDashboardAccessError(error, "Could not add the workspace. Try again.");
}

function readWorkspaceLabel(project: { id: string; name: string }): string {
  const name = project.name.trim();
  return name.length === 0 || name === "Default project" || name === project.id
    ? "Your workspace"
    : name;
}

function readWebsiteFaviconSource(origin: string | null | undefined): string | null {
  return origin === null || origin === undefined ? null : websiteFaviconUrl(new URL(origin));
}
