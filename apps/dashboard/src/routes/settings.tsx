import { useState } from "react";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useProjectSettingsEditor } from "./settings/settings-editor-state";
import { SettingsPanel } from "./settings/settings-editor";
import { SettingsHealthAlert } from "./settings/settings-environment";
import { SettingsNav, type SettingsSectionId } from "./settings/settings-nav";

export function SettingsPage() {
  const { projectId } = useDashboardWorkspace();
  const editor = useProjectSettingsEditor(projectId);
  const [active, setActive] = useState<SettingsSectionId>("websites");

  return (
    <div className="flex flex-col gap-5">
      <SettingsHealthAlert />

      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]">Settings</h1>
          <p className="mt-1 text-[12px] leading-normal text-muted-foreground">
            Websites, recording controls, and access.
          </p>
        </div>
        <span
          className={cn(
            "transition-opacity duration-200",
            editor.state.savedVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <Badge color="green" size="sm" variant="dot">
            Saved
          </Badge>
        </span>
      </div>

      <div className="grid gap-5 md:grid-cols-[204px_minmax(0,1fr)]">
        <SettingsNav active={active} onSelect={setActive} />
        <SettingsPanel active={active} editor={editor} projectId={projectId} />
      </div>
    </div>
  );
}
