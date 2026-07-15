import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { SessionsPanel } from "./sessions/sessions-panel";

export function SessionsPage() {
  const { projectId, isDemo } = useDashboardWorkspace();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h1 className="text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]">Sessions</h1>
      </div>
      <SessionsPanel isDemo={isDemo} projectId={projectId} />
    </div>
  );
}
