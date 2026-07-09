import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { InstallSnippetBuilder } from "./install/install-snippet-builder";
import { InstallStatus } from "./install/install-status";

export function InstallPage() {
  const { projectId } = useDashboardWorkspace();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Install
          <span className="ml-2.5 text-[12px] font-normal text-dim">
            Add the snippet and verify events arrive.
          </span>
        </h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <InstallSnippetBuilder projectId={projectId} />
        <InstallStatus projectId={projectId} />
      </div>
    </div>
  );
}
