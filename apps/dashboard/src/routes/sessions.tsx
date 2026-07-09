import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { SessionsPanel } from "./sessions/sessions-panel";

export function SessionsPage() {
  const { projectId, isDemo } = useDashboardWorkspace();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Sessions
          <span className="ml-2.5 text-[12px] font-normal text-dim">
            Watch how people actually used your product.
          </span>
        </h1>
      </div>
      <SessionsPanel isDemo={isDemo} projectId={projectId} />
    </div>
  );
}
