import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
  redirect,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import {
  openProjectsHome,
  requireActivationAccess,
  requireAdminAccess,
  requireProjectAccess,
  requireProjectManager,
} from "@/lib/route-guard";
import { DashboardWorkspaceProvider } from "@/lib/dashboard-workspace";
import { AppShell } from "@/routes/app-shell";
import { RouteError } from "@/routes/route-error";
import { validateSessionSearch } from "@/lib/session-filters";
import { validateSessionsViewSearch } from "@/lib/sessions-view-search";

interface LoginSearch {
  reason?: string;
  returnTo?: string;
}

const rootRoute = createRootRoute({
  component: Outlet,
  errorComponent: RouteErrorBoundary,
  notFoundComponent: () => <RouteError notFound />,
});

const AdminPage = lazyRouteComponent(() => import("@/routes/admin"), "AdminPage");
const DemoRoute = lazyRouteComponent(() => import("@/routes/demo"), "DemoRoute");
const InstallPage = lazyRouteComponent(() => import("@/routes/install"), "InstallPage");
const LivePage = lazyRouteComponent(() => import("@/routes/live"), "LivePage");
const LoginPage = lazyRouteComponent(() => import("@/routes/login"), "LoginPage");
const LocalLabPage = lazyRouteComponent(() => import("@/routes/local-workbench"), "LocalLabPage");
const LocalLabsIndexPage = lazyRouteComponent(
  () => import("@/routes/local-workbench"),
  "LocalLabsIndexPage",
);
const OnboardingShell = lazyRouteComponent(
  () => import("@/routes/onboarding/onboarding-shell"),
  "OnboardingShell",
);
const OnboardingWebsitePage = lazyRouteComponent(
  () => import("@/routes/onboarding/onboarding-website-step"),
  "OnboardingWebsitePage",
);
const OnboardingInstallPage = lazyRouteComponent(
  () => import("@/routes/onboarding/onboarding-install-step"),
  "OnboardingInstallPage",
);
const OnboardingVerifyPage = lazyRouteComponent(
  () => import("@/routes/onboarding/onboarding-verify-step"),
  "OnboardingVerifyPage",
);
const OverviewPage = lazyRouteComponent(() => import("@/routes/overview"), "OverviewPage");
const ProjectsPage = lazyRouteComponent(() => import("@/routes/projects"), "ProjectsPage");
const SessionDetailPage = lazyRouteComponent(
  () => import("@/routes/session-detail"),
  "SessionDetailPage",
);
const SessionsPage = lazyRouteComponent(() => import("@/routes/sessions"), "SessionsPage");
const SettingsPage = lazyRouteComponent(() => import("@/routes/settings"), "SettingsPage");

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    reason: typeof search["reason"] === "string" ? search["reason"] : undefined,
    returnTo: typeof search["returnTo"] === "string" ? search["returnTo"] : undefined,
  }),
  component: LoginPage,
});

const localLabsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/local-labs",
  beforeLoad: requireDevelopmentMode,
  component: LocalLabsIndexPage,
});

const localLabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/local-labs/$labId",
  beforeLoad: requireDevelopmentMode,
  component: LocalLabPage,
});

// Activation is one flow of three screens: the shell holds the shared draft and
// the dashboard preview, and each screen is its own route so every step is
// deep-linkable and Back is ordinary browser history.
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: Outlet,
  errorComponent: RouteErrorBoundary,
});

const onboardingIndexRoute = createRoute({
  getParentRoute: () => onboardingRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/projects", replace: true });
  },
});

const onboardingProjectRoute = createRoute({
  getParentRoute: () => onboardingRoute,
  path: "$projectId",
  beforeLoad: ({ location, params }) => requireActivationAccess(location, params.projectId),
  component: OnboardingShell,
});

const onboardingProjectIndexRoute = createRoute({
  getParentRoute: () => onboardingProjectRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/onboarding/$projectId/website",
      params: { projectId: params.projectId },
      replace: true,
    });
  },
});

const onboardingWebsiteRoute = createRoute({
  getParentRoute: () => onboardingProjectRoute,
  path: "website",
  validateSearch: onboardingWebsiteSearch,
  component: OnboardingWebsitePage,
});

function onboardingStepSearch(search: Record<string, unknown>): { website?: string } {
  const website = search["website"];
  return typeof website === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(website) ? { website } : {};
}

function onboardingWebsiteSearch(search: Record<string, unknown>): {
  website?: string;
  draft?: string;
} {
  const website = onboardingStepSearch(search);
  const draft = search["draft"];
  return typeof draft === "string" && draft.length <= 2_048 ? { ...website, draft } : website;
}

const onboardingInstallRoute = createRoute({
  getParentRoute: () => onboardingProjectRoute,
  path: "install",
  validateSearch: onboardingStepSearch,
  component: OnboardingInstallPage,
});

const onboardingVerifyRoute = createRoute({
  getParentRoute: () => onboardingProjectRoute,
  path: "verify",
  validateSearch: onboardingStepSearch,
  component: OnboardingVerifyPage,
});

const rootIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({
      to: "/projects",
      replace: true,
    });
  },
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  beforeLoad: ({ location }) => openProjectsHome(location),
  component: ProjectsPage,
  errorComponent: RouteErrorBoundary,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/_admin",
  beforeLoad: ({ location }) => requireAdminAccess(location),
  component: AdminPage,
  errorComponent: RouteErrorBoundary,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  beforeLoad: ({ location, params }) => requireProjectAccess(location, params.projectId),
  component: ProjectAppShell,
  errorComponent: RouteErrorBoundary,
  notFoundComponent: () => <RouteError notFound />,
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/projects/$projectId/overview",
      params: { projectId: params.projectId },
      replace: true,
    });
  },
});

const overviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "overview",
  validateSearch: validateSessionSearch,
  component: OverviewPage,
});

const sessionsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "sessions",
  validateSearch: validateSessionsViewSearch,
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
  beforeLoad: ({ location, params }) => requireProjectManager(location, params.projectId),
  component: SettingsPage,
});

const installRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "install",
  beforeLoad: ({ location, params }) => requireProjectManager(location, params.projectId),
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
      to: "/demo/overview",
      replace: true,
    });
  },
});

const demoOverviewRoute = createRoute({
  getParentRoute: () => demoRoute,
  path: "overview",
  validateSearch: validateSessionSearch,
  component: OverviewPage,
});

const demoSessionsRoute = createRoute({
  getParentRoute: () => demoRoute,
  path: "sessions",
  validateSearch: validateSessionsViewSearch,
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
  localLabsIndexRoute,
  localLabRoute,
  rootIndexRoute,
  projectsRoute,
  adminRoute,
  onboardingRoute.addChildren([
    onboardingIndexRoute,
    onboardingProjectRoute.addChildren([
      onboardingProjectIndexRoute,
      onboardingWebsiteRoute,
      onboardingInstallRoute,
      onboardingVerifyRoute,
    ]),
  ]),
  demoRoute.addChildren([
    demoIndexRoute,
    demoOverviewRoute,
    demoSessionsRoute,
    demoSessionDetailRoute,
    demoLiveRoute,
  ]),
  projectRoute.addChildren([
    projectIndexRoute,
    overviewRoute,
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

function requireDevelopmentMode() {
  if (!import.meta.env.DEV) {
    throw notFound();
  }
}

function ProjectAppShell() {
  const { projectId } = projectRoute.useParams();
  return (
    <DashboardWorkspaceProvider isDemo={false} projectId={projectId}>
      <AppShell />
    </DashboardWorkspaceProvider>
  );
}
