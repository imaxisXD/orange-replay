import { Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchDemoWorkspace } from "@/lib/api";
import { DemoWorkspaceProvider } from "@/lib/dashboard-workspace";
import { DemoUnavailableStateContent } from "@/lib/demo-unavailable-state";
import { RotateCcw } from "@/lib/icon-map";
import { AppShell } from "./app-shell";

const fallbackDemoProjectId = "demo";

export function DemoRoute() {
  const demoQuery = useQuery({
    queryKey: ["demo-workspace"],
    queryFn: ({ signal }) => fetchDemoWorkspace({ signal }),
    retry: false,
  });
  const projectId = demoQuery.data?.projectId ?? fallbackDemoProjectId;

  return (
    <DemoWorkspaceProvider projectId={projectId}>
      <AppShell>
        {demoQuery.isPending ? (
          <DemoLoadingState />
        ) : demoQuery.isError ? (
          <DemoUnavailableState
            error={demoQuery.error}
            onRetry={() => {
              void demoQuery.refetch();
            }}
          />
        ) : (
          <Outlet />
        )}
      </AppShell>
    </DemoWorkspaceProvider>
  );
}

function DemoLoadingState() {
  return (
    <section className="mx-auto flex min-h-105 w-full max-w-md items-center justify-center">
      <div className="lit flex w-full flex-col gap-4 overflow-hidden rounded-lg p-6">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-7" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-8 w-24" />
      </div>
    </section>
  );
}

export function DemoUnavailableState({
  error,
  onRetry,
}: {
  error?: unknown;
  onRetry?: () => void;
}) {
  return (
    <DemoUnavailableStateContent
      actions={
        <>
          <Button asChild>
            <a href="/login">Start free</a>
          </Button>
          {onRetry !== undefined && (
            <Button leadingIcon={RotateCcw} onClick={onRetry} variant="secondary">
              Retry
            </Button>
          )}
        </>
      }
      brand={
        <>
          <BrandMark className="size-7" />
          <span className="text-[14px] font-medium">Orange Replay</span>
        </>
      }
      error={error}
    />
  );
}
