import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { SessionsPanel } from "./sessions/sessions-panel";

export function SessionsPage() {
  const { projectId, isDemo } = useDashboardWorkspace();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">Sessions</h1>
        <p className="text-[13px] text-muted-foreground sm:text-[12px]">
          Watch how people actually used your product.
        </p>
      </div>
      <SessionsPanel isDemo={isDemo} projectId={projectId} />
    </div>
  );
}
