import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { useQuery } from "@tanstack/react-query";
import { accountQueryKey, fetchAccount, getApiToken } from "@/lib/api";
import { SettingsEditor } from "./settings/settings-editor";
import { SettingsEnvironmentCards, SettingsHealthAlert } from "./settings/settings-environment";
import { KeysCard } from "./settings/settings-keys-card";
import { PublicPageCard } from "./settings/settings-public-page-card";

export function SettingsPage() {
  const { projectId } = useDashboardWorkspace();
  const usesLocalToken = getApiToken() !== null;
  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: fetchAccount,
    enabled: !usesLocalToken,
    staleTime: 30_000,
  });

  return (
    <div className="flex flex-col gap-5">
      <SettingsHealthAlert />
      <SettingsEditor projectId={projectId}>
        <KeysCard projectId={projectId} />
        <PublicPageCard projectId={projectId} />
      </SettingsEditor>
      <SettingsEnvironmentCards hosted={!usesLocalToken && accountQuery.data !== undefined} />
    </div>
  );
}
