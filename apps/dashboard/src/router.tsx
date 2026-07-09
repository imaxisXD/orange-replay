import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { defaultProjectId } from "@/lib/routes";
import { requireProjectToken } from "@/lib/route-guard";
import { DashboardWorkspaceProvider } from "@/lib/dashboard-workspace";
import { AppShell } from "@/routes/app-shell";
import { DemoRoute } from "@/routes/demo";
import { InstallPage } from "@/routes/install";
import { LivePage } from "@/routes/live";
import { LoginPage } from "@/routes/login";
import { RouteError } from "@/routes/route-error";
import { SessionDetailPage } from "@/routes/session-detail";
import { SessionsPage } from "@/routes/sessions";
import { SettingsPage } from "@/routes/settings";

interface LoginSearch {
  reason?: string;
  returnTo?: string;
}

const rootRoute = createRootRoute({
  component: Outlet,
  errorComponent: RouteErrorBoundary,
  notFoundComponent: () => <RouteError notFound />,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    reason: typeof search["reason"] === "string" ? search["reason"] : undefined,
    returnTo: typeof search["returnTo"] === "string" ? search["returnTo"] : undefined,
  }),
  component: LoginPage,
});

const rootIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({
      to: "/projects/$projectId/sessions",
      params: { projectId: defaultProjectId },
      replace: true,
    });
  },
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  beforeLoad: ({ location }) => {
    requireProjectToken(location);
  },
  component: ProjectAppShell,
  errorComponent: RouteErrorBoundary,
  notFoundComponent: () => <RouteError notFound />,
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/projects/$projectId/sessions",
      params: { projectId: params.projectId },
      replace: true,
    });
  },
});

const sessionsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "sessions",
  component: SessionsPage,
});

const sessionDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "sessions/$sessionId",
  component: SessionDetailPage,
});

const liveRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "live",
  component: LivePage,
});

const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "settings",
  component: SettingsPage,
});

const installRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "install",
  component: InstallPage,
});

const demoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/demo",
  component: DemoRoute,
  errorComponent: RouteErrorBoundary,
  notFoundComponent: () => <RouteError notFound />,
});

const demoIndexRoute = createRoute({
  getParentRoute: () => demoRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({
      to: "/demo/sessions",
      replace: true,
    });
  },
});

const demoSessionsRoute = createRoute({
  getParentRoute: () => demoRoute,
  path: "sessions",
  component: SessionsPage,
});

const demoSessionDetailRoute = createRoute({
  getParentRoute: () => demoRoute,
  path: "sessions/$sessionId",
  component: SessionDetailPage,
});

const demoLiveRoute = createRoute({
  getParentRoute: () => demoRoute,
  path: "live",
  component: LivePage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  rootIndexRoute,
  demoRoute.addChildren([demoIndexRoute, demoSessionsRoute, demoSessionDetailRoute, demoLiveRoute]),
  projectRoute.addChildren([
    projectIndexRoute,
    sessionsRoute,
    sessionDetailRoute,
    liveRoute,
    settingsRoute,
    installRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function RouteErrorBoundary({ error }: ErrorComponentProps) {
  return <RouteError error={error} />;
}

function ProjectAppShell() {
  const { projectId } = projectRoute.useParams();
  return (
    <DashboardWorkspaceProvider isDemo={false} projectId={projectId}>
      <AppShell />
    </DashboardWorkspaceProvider>
  );
}
