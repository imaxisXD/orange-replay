import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { InstallSnippetBuilder } from "./install/install-snippet-builder";
import { InstallStatus } from "./install/install-status";

export function InstallPage() {
  const { projectId } = useDashboardWorkspace();

  return (
    <div className="flex flex-col gap-5">
      <header className="flex max-w-2xl flex-col gap-1">
        <h1 className="text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]">Install</h1>
        <p className="text-[12px] leading-normal text-muted-foreground">
          Add the snippet and verify events arrive.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <InstallSnippetBuilder projectId={projectId} />
        <InstallStatus projectId={projectId} />
      </div>
    </div>
  );
}
