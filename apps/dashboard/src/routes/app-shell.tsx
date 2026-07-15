import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import { accountQueryKey, fetchAccount } from "@/lib/api";
import {
  canManageProject,
  findAccountProject,
  readDashboardAccess,
  readDashboardAccessError,
  signOutDashboardAccess,
} from "@/lib/dashboard-access";
import { getDashboardEnvironmentLabel } from "@/lib/dashboard-environment";
import { ArrowUpRight, ShieldUser } from "@/lib/icon-map";
import { dashboardNavItems, type DashboardNavItem } from "@/lib/dashboard-navigation";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { surfaceClasses } from "@/lib/surface-classes";
import { SurfaceProvider } from "@/lib/surface-context";
import { cn } from "@/lib/utils";

const DASHBOARD_SURFACE_LEVEL = 2;

export function AppShell({ children }: { children?: ReactNode }) {
  const { projectId, isDemo } = useDashboardWorkspace();
  const environmentLabel = getDashboardEnvironmentLabel(
    isDemo,
    import.meta.env.VITE_DASHBOARD_ENVIRONMENT,
  );
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const activeAccess = readDashboardAccess(isDemo ? "demo" : "private");
  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: fetchAccount,
    enabled: activeAccess.needsAccount,
    staleTime: 30_000,
  });
  const account = accountQuery.data;
  const projectOptions = isDemo
    ? [{ id: projectId, label: "Landing page" }]
    : (account?.workspaces.flatMap((workspace) =>
        workspace.projects.map((project) => ({
          id: project.id,
          label:
            account.workspaces.length > 1 ? `${workspace.name} / ${project.name}` : project.name,
        })),
      ) ?? [{ id: projectId, label: `Project ${projectId}` }]);
  const activeProject = findAccountProject(account, projectId);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The two-pane sessions triage needs a real player viewport; every other
  // screen keeps the design language's 1200px column.
  const wideMain = /\/sessions\/?$/.test(pathname);

  async function handleLogout(): Promise<void> {
    setIsSigningOut(true);
    setSignOutError("");
    try {
      await signOutDashboardAccess();
      void navigate({ to: "/login", replace: true });
    } catch (error) {
      setSignOutError(readDashboardAccessError(error, "Could not sign out. Try again."));
    }
    setIsSigningOut(false);
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden text-foreground">
      <header className="z-40 shrink-0">
        <ScrollArea orientation="horizontal" viewportClassName="scroll-fade-x">
          <nav className="flex min-w-max items-center gap-3.5 px-4 py-2 sm:px-7">
            <Link
              className="flex items-center gap-2.5 text-[14px] font-semibold tracking-[-0.01em] text-foreground"
              {...(isDemo
                ? { to: "/demo/overview" as const }
                : { params: { projectId }, to: "/projects/$projectId/overview" as const })}
            >
              <BrandMark />
              <span>Orange Replay</span>
            </Link>

            <span className="text-divider">/</span>

            <Select
              onValueChange={(nextProjectId) => {
                if (isDemo) {
                  void navigate({ to: "/demo/overview" });
                  return;
                }
                void navigate({
                  to: "/projects/$projectId/overview",
                  params: { projectId: nextProjectId },
                });
              }}
              value={projectId}
            >
              <SelectTrigger
                aria-label="Project"
                className="h-7.5 min-w-33 rounded-lg border border-subtle-border bg-secondary px-2.75 py-1.25 text-[12.5px] text-foreground"
                placeholder="Project"
              />
              <SelectContent className="rounded-lg border border-border bg-popover">
                <SelectGroup>
                  <SelectLabel>Projects</SelectLabel>
                  {projectOptions.map((project, index) => (
                    <SelectItem index={index} key={project.id} value={project.id}>
                      {project.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>

            <Badge color="amber" size="sm">
              {environmentLabel}
            </Badge>

            <div className="ml-auto flex items-center gap-4">
              {!isDemo && account?.isAdmin === true && (
                <Button asChild leadingIcon={ShieldUser} size="sm" variant="ghost">
                  <Link to="/_admin">Operator</Link>
                </Button>
              )}
              {!isDemo && (
                <div className="flex items-center gap-2">
                  {signOutError.length > 0 && (
                    <p className="max-w-48 text-right text-[11.5px] text-danger" role="alert">
                      {signOutError}
                    </p>
                  )}
                  <Button
                    className="h-auto px-0 py-0 text-[12.5px] text-muted-foreground hover:text-foreground"
                    loading={isSigningOut}
                    onClick={() => void handleLogout()}
                    variant="ghost"
                  >
                    Log out
                  </Button>
                </div>
              )}
              {isDemo ? (
                <span
                  aria-hidden="true"
                  className="size-6.5 rounded-full border border-border bg-[linear-gradient(135deg,var(--teal-soft),var(--teal))]"
                />
              ) : (
                <AccountAvatar image={account?.user.image} name={account?.user.name} />
              )}
            </div>
          </nav>
        </ScrollArea>
      </header>

      <div className="min-h-0 flex-1 px-2 pb-2 sm:px-3 sm:pb-3">
        <SurfaceProvider value={DASHBOARD_SURFACE_LEVEL}>
          <div
            className={cn(
              "flex h-full min-h-0 flex-col overflow-hidden rounded-xl",
              surfaceClasses(DASHBOARD_SURFACE_LEVEL),
            )}
          >
            <ScrollArea orientation="horizontal" viewportClassName="scroll-fade-x">
              <nav className="flex min-w-max gap-1 border-b border-border px-4 sm:px-7">
                {dashboardNavItems(isDemo, canManageProject(activeProject)).map((item) => (
                  <TopNavTab isDemo={isDemo} item={item} key={item.label} projectId={projectId} />
                ))}
              </nav>
            </ScrollArea>

            {isDemo && <DemoReadOnlyBanner />}

            <ScrollArea className="min-h-0 flex-1" viewportClassName="scroll-fade">
              <main
                className={cn(
                  "mx-auto w-full max-w-full px-4 py-5 sm:px-7 sm:py-6",
                  wideMain ? "max-w-475" : "max-w-300",
                )}
              >
                {children ?? <Outlet />}
              </main>
            </ScrollArea>
          </div>
        </SurfaceProvider>
      </div>
    </div>
  );
}

function AccountAvatar({ image, name }: { image?: string | null; name?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initials = readInitials(name);

  if (image !== undefined && image !== null && image.length > 0 && !imageFailed) {
    return (
      <img
        alt={name === undefined ? "Account" : name}
        className="size-6.5 rounded-full border border-border bg-secondary object-cover"
        onError={() => setImageFailed(true)}
        referrerPolicy="no-referrer"
        src={image}
      />
    );
  }

  return (
    <span
      aria-label={name === undefined ? "Account" : name}
      className="flex size-6.5 items-center justify-center rounded-full border border-border bg-[linear-gradient(135deg,var(--teal-soft),var(--teal))] text-[10px] font-semibold text-background"
      role="img"
    >
      {initials}
    </span>
  );
}

function readInitials(name: string | undefined): string {
  if (name === undefined || name.trim().length === 0) return "OR";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function TopNavTab({
  isDemo,
  item,
  projectId,
}: {
  isDemo: boolean;
  item: DashboardNavItem;
  projectId: string;
}) {
  if (isDemo && item.demoTo !== undefined) {
    return (
      <Link
        activeProps={{
          className: "border-amber font-medium text-foreground",
        }}
        className={cn(
          "-mb-px border-b-2 border-transparent px-3.25 py-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:py-2.5",
        )}
        to={item.demoTo}
      >
        {item.label}
      </Link>
    );
  }

  return (
    <Link
      activeProps={{
        className: "border-amber font-medium text-foreground",
      }}
      className={cn(
        "-mb-px border-b-2 border-transparent px-3.25 py-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:py-2.5",
      )}
      params={{ projectId }}
      to={item.projectTo}
    >
      {item.label}
    </Link>
  );
}

function DemoReadOnlyBanner() {
  return (
    <div className="demo-banner border-b border-dashed border-amber/25 px-4 py-1.5 sm:px-7">
      <span aria-hidden className="demo-beam" />
      <div className="mx-auto flex max-w-300 items-center gap-3">
        <span aria-hidden className="demo-scan-dot max-sm:hidden" />
        <p className="text-[12.5px] text-muted-foreground max-sm:hidden">
          Our <strong className="font-semibold text-foreground">own</strong> landing page, recorded
          with our <strong className="font-semibold text-foreground">own</strong> product.{" "}
          <span className="text-foreground">
            Look closely — you might{" "}
            <mark className="rounded-[3px] bg-amber/15 px-1 text-amber">spot yourself.</mark>
          </span>
        </p>
        <Link
          className="demo-cta group ml-auto flex items-center gap-2.5 rounded-[9px] bg-white py-1.25 pl-3.25 pr-1.5 text-[14px] font-[550] tracking-[-0.01em] text-black"
          to="/login"
        >
          Start free
          <span className="flex size-5.5 items-center justify-center rounded-full bg-black text-white">
            <ArrowUpRight
              className="transition-transform duration-200 ease-out group-hover:rotate-45"
              size={13}
              strokeWidth={1.5}
            />
          </span>
        </Link>
      </div>
    </div>
  );
}
