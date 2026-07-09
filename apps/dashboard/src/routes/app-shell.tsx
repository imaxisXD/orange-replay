import { type ReactNode } from "react";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import { clearApiToken } from "@/lib/api";
import { dashboardNavItems, type DashboardNavItem } from "@/lib/dashboard-navigation";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children?: ReactNode }) {
  const { projectId, isDemo } = useDashboardWorkspace();
  const navigate = useNavigate();
  const projectOptions = [{ id: projectId, label: `Project ${projectId}` }];

  function handleLogout(): void {
    clearApiToken();
    void navigate({ to: "/login", replace: true });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40">
        <nav className="flex items-center gap-3.5 border-b border-border bg-chrome px-7 py-3 backdrop-blur">
          <Link
            className="flex items-center gap-2.5 text-[14px] font-semibold tracking-[-0.01em] text-foreground"
            {...(isDemo
              ? { to: "/demo/sessions" as const }
              : { params: { projectId }, to: "/projects/$projectId/sessions" as const })}
          >
            <BrandMark />
            <span>Orange Replay</span>
          </Link>

          <span className="text-divider">/</span>

          <Select
            onValueChange={(nextProjectId) => {
              if (isDemo) {
                void navigate({ to: "/demo/sessions" });
                return;
              }
              void navigate({
                to: "/projects/$projectId/sessions",
                params: { projectId: nextProjectId },
              });
            }}
            value={projectId}
          >
            <SelectTrigger
              aria-label="Project"
              className="h-auto min-w-33 rounded-lg border border-border bg-card px-2.75 py-1.25 text-[12.5px] text-foreground [&_svg]:size-2.25 [&_svg]:text-dim"
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

        <nav className="flex gap-1 border-b border-border bg-chrome px-7">
          {dashboardNavItems(isDemo).map((item) => (
            <TopNavTab isDemo={isDemo} item={item} key={item.label} projectId={projectId} />
          ))}
        </nav>

        {isDemo && <DemoReadOnlyBanner />}
      </header>

      <main className="mx-auto w-full max-w-300 px-7 py-6">{children ?? <Outlet />}</main>
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
          "-mb-px border-b-2 border-transparent px-3.25 py-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
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
        "-mb-px border-b-2 border-transparent px-3.25 py-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
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
    <div className="border-b border-dashed border-amber/35 bg-[rgba(245,166,35,0.07)] px-7 py-2">
      <div className="mx-auto flex max-w-300 items-center gap-3">
        <span
          aria-hidden
          className="size-1.75 rounded-full bg-amber shadow-[0_0_10px_var(--amber-shadow)]"
        />
        <p className="text-[12.5px] text-foreground">
          Live demo — real sessions from our landing page, read-only.
        </p>
        <Button asChild className="ml-auto" size="sm">
          <Link to="/login">Start free</Link>
        </Button>
      </div>
    </div>
  );
}
