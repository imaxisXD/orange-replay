import {
  Download,
  LayoutDashboard,
  LiveStreaming,
  PlayCircle,
  Settings,
  type IconComponent,
} from "@/lib/icon-map";

export type ProjectNavPath =
  | "/projects/$projectId/install"
  | "/projects/$projectId/live"
  | "/projects/$projectId/overview"
  | "/projects/$projectId/sessions"
  | "/projects/$projectId/settings";

export type DemoNavPath = "/demo/live" | "/demo/overview" | "/demo/sessions";

export interface DashboardNavItem {
  demoTo?: DemoNavPath;
  icon: IconComponent;
  label: string;
  projectTo: ProjectNavPath;
}

const allNavItems: DashboardNavItem[] = [
  {
    label: "Overview",
    icon: LayoutDashboard,
    projectTo: "/projects/$projectId/overview",
    demoTo: "/demo/overview",
  },
  {
    label: "Sessions",
    icon: PlayCircle,
    projectTo: "/projects/$projectId/sessions",
    demoTo: "/demo/sessions",
  },
  {
    label: "Live",
    icon: LiveStreaming,
    projectTo: "/projects/$projectId/live",
    demoTo: "/demo/live",
  },
  { label: "Settings", icon: Settings, projectTo: "/projects/$projectId/settings" },
  { label: "Install", icon: Download, projectTo: "/projects/$projectId/install" },
];

export function dashboardNavItems(isDemo: boolean, canManageProject = true): DashboardNavItem[] {
  if (isDemo) return allNavItems.filter((item) => item.demoTo !== undefined);
  if (canManageProject) return allNavItems;
  return allNavItems.filter((item) => item.label !== "Settings" && item.label !== "Install");
}
