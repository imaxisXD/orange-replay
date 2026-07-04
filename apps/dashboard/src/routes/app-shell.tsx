import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router";
import { Monitor, Settings, SquareLibrary } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { clearApiToken } from "@/lib/api";
import { cn } from "@/lib/utils";
import { defaultProjectId } from "@/router";

const themeStorageKey = "or:theme";

export function AppShell() {
  const params = useParams();
  const projectId = params.projectId ?? defaultProjectId;
  const navigate = useNavigate();
  const [darkMode, setDarkMode] = useState(() => getInitialDarkMode());

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    window.localStorage.setItem(themeStorageKey, darkMode ? "dark" : "light");
  }, [darkMode]);

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
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[240px_1fr]">
        <aside className="border-b border-border bg-card lg:border-b-0 lg:border-r">
          <div className="flex h-16 items-center justify-between px-5 lg:h-auto lg:flex-col lg:items-start lg:gap-8 lg:px-5 lg:py-6">
            <Link
              className="flex items-center gap-2 font-semibold tracking-normal"
              to={`/projects/${projectId}/sessions`}
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                OR
              </span>
              <span>Orange Replay</span>
            </Link>

            <nav className="flex items-center gap-2 lg:w-full lg:flex-col lg:items-stretch">
              <NavItem
                icon={<SquareLibrary aria-hidden className="size-4" />}
                label="Sessions"
                to={`/projects/${projectId}/sessions`}
              />
              <NavItem
                icon={<Settings aria-hidden className="size-4" />}
                label="Settings"
                to={`/projects/${projectId}/settings`}
              />
            </nav>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-4 py-3 md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <Select
                onValueChange={(nextProjectId) => navigate(`/projects/${nextProjectId}/sessions`)}
                value={projectId}
              >
                <SelectTrigger aria-label="Project" placeholder="Project" />
                <SelectContent>
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

              <Badge color="orange" size="sm" variant="dot">
                Org o1
              </Badge>
            </div>

            <div className="flex items-center gap-2">
              <Tooltip content="Use dark mode">
                <div>
                  <Switch
                    checked={darkMode}
                    label="Dark"
                    onToggle={() => setDarkMode((current) => !current)}
                  />
                </div>
              </Tooltip>
              <Button leadingIcon={Monitor} onClick={handleLogout} size="sm" variant="tertiary">
                Log out
              </Button>
            </div>
          </header>

          <main className="min-w-0 flex-1 px-4 py-6 md:px-6">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

function NavItem({ icon, label, to }: { icon: ReactNode; label: string; to: string }) {
  return (
    <NavLink
      className={({ isActive }) =>
        cn(
          "flex h-9 items-center gap-2 rounded-lg px-3 text-sm transition-colors",
          isActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-hover hover:text-foreground",
        )
      }
      to={to}
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

function getInitialDarkMode(): boolean {
  const savedTheme = window.localStorage.getItem(themeStorageKey);
  if (savedTheme === "dark") return true;
  if (savedTheme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
