import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { SettingsEditor } from "./settings/settings-editor";
import { SettingsEnvironmentCards, SettingsHealthAlert } from "./settings/settings-environment";
import { KeysCard } from "./settings/settings-keys-card";

export function SettingsPage() {
  const { projectId } = useDashboardWorkspace();

  return (
    <div className="flex flex-col gap-5">
      <SettingsHealthAlert />
      <SettingsEditor projectId={projectId}>
        <KeysCard projectId={projectId} />
      </SettingsEditor>
      <SettingsEnvironmentCards />
    </div>
  );
}
