export type ProjectNavPath =
  | "/projects/$projectId/install"
  | "/projects/$projectId/live"
  | "/projects/$projectId/overview"
  | "/projects/$projectId/sessions"
  | "/projects/$projectId/settings";

export type DemoNavPath = "/demo/live" | "/demo/overview" | "/demo/sessions";

export interface DashboardNavItem {
  demoTo?: DemoNavPath;
  label: string;
  projectTo: ProjectNavPath;
}

const allNavItems: DashboardNavItem[] = [
  { label: "Overview", projectTo: "/projects/$projectId/overview", demoTo: "/demo/overview" },
  { label: "Sessions", projectTo: "/projects/$projectId/sessions", demoTo: "/demo/sessions" },
  { label: "Live", projectTo: "/projects/$projectId/live", demoTo: "/demo/live" },
  { label: "Settings", projectTo: "/projects/$projectId/settings" },
  { label: "Install", projectTo: "/projects/$projectId/install" },
];

export function dashboardNavItems(isDemo: boolean): DashboardNavItem[] {
  return isDemo ? allNavItems.filter((item) => item.demoTo !== undefined) : allNavItems;
}
