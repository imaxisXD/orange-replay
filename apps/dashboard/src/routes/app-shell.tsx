import { type ReactNode } from "react";
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
import { clearApiToken } from "@/lib/api";
import { ArrowUpRight } from "@/lib/icon-map";
import { dashboardNavItems, type DashboardNavItem } from "@/lib/dashboard-navigation";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children?: ReactNode }) {
  const { projectId, isDemo } = useDashboardWorkspace();
  const navigate = useNavigate();
  const projectOptions = [{ id: projectId, label: `Project ${projectId}` }];
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The two-pane sessions triage needs a real player viewport; every other
  // screen keeps the design language's 1200px column.
  const wideMain = /\/sessions\/?$/.test(pathname);

  function handleLogout(): void {
    clearApiToken();
    void navigate({ to: "/login", replace: true });
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="z-40 shrink-0 bg-background">
        <ScrollArea orientation="horizontal" viewportClassName="scroll-fade-x">
          <nav className="flex min-w-max items-center gap-3.5 border-b border-border bg-chrome px-4 py-3 backdrop-blur sm:px-7">
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
                className="min-w-33 rounded-lg border border-border bg-secondary px-2.75 py-1.25 text-[12.5px] text-foreground "
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
              {isDemo ? "Demo" : "Local dev"}
            </Badge>

            <div className="ml-auto flex items-center gap-4">
              {!isDemo && (
                <Button
                  className="h-auto px-0 py-0 text-[12.5px] text-muted-foreground hover:text-foreground"
                  onClick={handleLogout}
                  variant="ghost"
                >
                  Log out
                </Button>
              )}
              <span
                aria-hidden="true"
                className="size-6.5 rounded-full border border-border bg-[linear-gradient(135deg,var(--teal-soft),var(--teal))]"
              />
            </div>
          </nav>
        </ScrollArea>

        <ScrollArea orientation="horizontal" viewportClassName="scroll-fade-x">
          <nav className="flex min-w-max gap-1 border-b border-border bg-chrome px-4 sm:px-7">
            {dashboardNavItems(isDemo).map((item) => (
              <TopNavTab isDemo={isDemo} item={item} key={item.label} projectId={projectId} />
            ))}
          </nav>
        </ScrollArea>

        {isDemo && <DemoReadOnlyBanner />}
      </header>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="scroll-fade">
        <main
          className={cn(
            "mx-auto w-dvw max-w-full px-4 py-5 sm:px-7 sm:py-6",
            wideMain ? "max-w-475" : "max-w-300",
          )}
        >
          {children ?? <Outlet />}
        </main>
      </ScrollArea>
    </div>
  );
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
