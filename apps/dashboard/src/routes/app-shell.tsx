import { useMemo, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router";
import { BrandMark } from "@/components/brand-mark";
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
import { cn } from "@/lib/utils";
import { defaultProjectId } from "@/router";

export function AppShell({ children }: { children?: ReactNode }) {
  const params = useParams();
  const projectId = params.projectId ?? defaultProjectId;
  const navigate = useNavigate();
  const projectOptions = useMemo(
    () => [{ id: projectId, label: `Project ${projectId}` }],
    [projectId],
  );

  function handleLogout(): void {
    clearApiToken();
    void navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40">
        <nav className="flex items-center gap-[14px] border-b border-border bg-[rgba(10,10,12,0.85)] px-[28px] py-3 backdrop-blur-[8px]">
          <Link
            className="flex items-center gap-[10px] text-[14px] font-semibold tracking-[-0.01em] text-foreground"
            to={`/projects/${projectId}/sessions`}
          >
            <BrandMark />
            <span>Orange Replay</span>
          </Link>

          <span className="text-[#33333b]">/</span>

          <Select
            onValueChange={(nextProjectId) => navigate(`/projects/${nextProjectId}/sessions`)}
            value={projectId}
          >
            <SelectTrigger
              aria-label="Project"
              className="h-auto min-w-[132px] rounded-lg border border-border bg-card px-[11px] py-[5px] text-[12.5px] text-foreground [&_svg]:size-[9px] [&_svg]:text-dim"
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

          <span className="rounded-full border border-dashed border-[rgba(245,166,35,0.35)] bg-[rgba(245,166,35,0.09)] px-[10px] py-[3px] text-[11px] font-medium text-amber">
            Local dev
          </span>

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
              className="size-[26px] rounded-full border border-border bg-[linear-gradient(135deg,#2dd4bf44,#2dd4bf)]"
            />
          </div>
        </nav>

        <nav className="flex gap-1 border-b border-border bg-[rgba(10,10,12,0.85)] px-[28px]">
          <TopNavTab label="Sessions" to={`/projects/${projectId}/sessions`} />
          <TopNavTab label="Live" to={`/projects/${projectId}/live`} />
          <TopNavTab label="Settings" to={`/projects/${projectId}/settings`} />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[1200px] px-[28px] py-6">{children ?? <Outlet />}</main>
    </div>
  );
}

function TopNavTab({ label, to }: { label: string; to: string }) {
  return (
    <NavLink
      className={({ isActive }) =>
        cn(
          "-mb-px border-b-2 border-transparent px-[13px] py-[10px] text-[13px] text-muted-foreground transition-colors hover:text-foreground",
          isActive && "border-amber font-medium text-foreground",
        )
      }
      to={to}
    >
      {label}
    </NavLink>
  );
}
