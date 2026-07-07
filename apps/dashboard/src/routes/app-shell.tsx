import { useMemo, type ReactNode } from "react";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
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
import { defaultProjectId } from "@/lib/routes";
import { cn } from "@/lib/utils";

export function AppShell({ children }: { children?: ReactNode }) {
  const params = useParams({ strict: false });
  const projectId = params.projectId ?? defaultProjectId;
  const navigate = useNavigate();
  const projectOptions = useMemo(
    () => [{ id: projectId, label: `Project ${projectId}` }],
    [projectId],
  );

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
            params={{ projectId }}
            to="/projects/$projectId/sessions"
          >
            <BrandMark />
            <span>Orange Replay</span>
          </Link>

          <span className="text-divider">/</span>

          <Select
            onValueChange={(nextProjectId) => {
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
            Local dev
          </Badge>

          <div className="ml-auto flex items-center gap-4">
            <Button
              className="h-auto px-0 py-0 text-[12.5px] text-muted-foreground hover:text-foreground"
              onClick={handleLogout}
              variant="ghost"
            >
              Log out
            </Button>
            <span
              aria-hidden="true"
              className="size-6.5 rounded-full border border-border bg-[linear-gradient(135deg,var(--teal-soft),var(--teal))]"
            />
          </div>
        </nav>

        <nav className="flex gap-1 border-b border-border bg-chrome px-7">
          <TopNavTab label="Sessions" projectId={projectId} to="/projects/$projectId/sessions" />
          <TopNavTab label="Live" projectId={projectId} to="/projects/$projectId/live" />
          <TopNavTab label="Settings" projectId={projectId} to="/projects/$projectId/settings" />
          <TopNavTab label="Install" projectId={projectId} to="/projects/$projectId/install" />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-300 px-7 py-6">{children ?? <Outlet />}</main>
    </div>
  );
}

function TopNavTab({
  label,
  projectId,
  to,
}: {
  label: string;
  projectId: string;
  to:
    | "/projects/$projectId/install"
    | "/projects/$projectId/live"
    | "/projects/$projectId/sessions"
    | "/projects/$projectId/settings";
}) {
  return (
    <Link
      activeProps={{
        className: "border-amber font-medium text-foreground",
      }}
      className={cn(
        "-mb-px border-b-2 border-transparent px-3.25 py-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
      )}
      params={{ projectId }}
      to={to}
    >
      {label}
    </Link>
  );
}
