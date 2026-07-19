// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
  type AnyRoute,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AccountResponse } from "../src/lib/api";
import { accountQueryKey } from "../src/lib/api";
import { DashboardWorkspaceProvider } from "../src/lib/dashboard-workspace";
import { validateSessionSearch } from "../src/lib/session-filters";
import { validateSessionsViewSearch } from "../src/lib/sessions-view-search";
import { ShapeProvider } from "../src/lib/shape-context";
import { AppShell } from "../src/routes/app-shell";

// happy-dom lacks this Web Animations API method that Base UI/ScrollArea call.
Object.defineProperty(Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});

// A doorway-shaped location: an explicit window plus a lens, a doorway pin, a
// selection, and a sort — every non-window key a tab click must drop.
const SEEDED_SEARCH =
  "?from=1000&to=2000&country=US&warehouse_version=5&selected=s-1&sort=friction";

describe("rendered top-nav date-range carry", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/");
  });

  it("shows demo tabs and carries only the window on every tab", async () => {
    const { tabs, teardown } = await renderShell(`/demo/sessions${SEEDED_SEARCH}`);
    expect(tabs.map((tab) => tab.text)).toEqual(["Overview", "Sessions", "Live"]);
    for (const tab of tabs) assertCarriesWindowOnly(tab.href);
    // Active-tab reset: clicking the current Sessions tab also drops the lenses.
    const active = tabs.find((tab) => tab.text === "Sessions");
    expect(active?.href).toContain("/demo/sessions?");
    assertCarriesWindowOnly(active?.href ?? "");
    await teardown();
  });

  it("shows the manager tab set and carries only the window", async () => {
    const { tabs, teardown } = await renderShell(
      `/projects/p-1/sessions${SEEDED_SEARCH}`,
      account("owner"),
    );
    expect(tabs.map((tab) => tab.text)).toEqual([
      "Overview",
      "Sessions",
      "Live",
      "Settings",
      "Install",
    ]);
    for (const tab of tabs) assertCarriesWindowOnly(tab.href);
    await teardown();
  });

  it("hides Settings/Install for a non-manager and still carries the window", async () => {
    const { tabs, teardown } = await renderShell(
      `/projects/p-1/sessions${SEEDED_SEARCH}`,
      account("member"),
    );
    expect(tabs.map((tab) => tab.text)).toEqual(["Overview", "Sessions", "Live"]);
    for (const tab of tabs) assertCarriesWindowOnly(tab.href);
    await teardown();
  });
});

function assertCarriesWindowOnly(href: string): void {
  const url = new URL(href, "http://dashboard.test");
  expect(url.searchParams.get("from")).toBe("1000");
  expect(url.searchParams.get("to")).toBe("2000");
  expect(url.searchParams.has("country")).toBe(false);
  expect(url.searchParams.has("warehouse_version")).toBe(false);
  expect(url.searchParams.has("selected")).toBe(false);
  expect(url.searchParams.has("sort")).toBe(false);
}

async function renderShell(initialPath: string, accountData?: AccountResponse) {
  const rootRoute = createRootRoute({ component: Outlet });

  const demoLayout = createRoute({
    getParentRoute: () => rootRoute,
    path: "/demo",
    component: () => (
      <DashboardWorkspaceProvider isDemo projectId="demo-project">
        <AppShell />
      </DashboardWorkspaceProvider>
    ),
  });
  const projectLayout = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    component: ProjectLayout,
  });

  const routeTree = rootRoute.addChildren([
    demoLayout.addChildren([
      leaf(demoLayout, "overview", validateSessionSearch),
      leaf(demoLayout, "sessions", validateSessionsViewSearch),
      leaf(demoLayout, "live"),
    ]),
    projectLayout.addChildren([
      leaf(projectLayout, "overview", validateSessionSearch),
      leaf(projectLayout, "sessions", validateSessionsViewSearch),
      leaf(projectLayout, "live"),
      leaf(projectLayout, "settings"),
      leaf(projectLayout, "install"),
    ]),
  ]);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  if (accountData !== undefined) queryClient.setQueryData(accountQueryKey, accountData);

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context: {},
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ShapeProvider defaultShape="rounded">
          <RouterProvider router={router} />
        </ShapeProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await router.load();
  });

  const tabNav = [...container.querySelectorAll("nav")].find((nav) =>
    nav.querySelector('a[href*="/sessions"]'),
  );
  const tabs = [...(tabNav?.querySelectorAll("a[href]") ?? [])].map((anchor) => ({
    text: (anchor.textContent ?? "").trim(),
    href: anchor.getAttribute("href") ?? "",
  }));

  return {
    tabs,
    teardown: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
    },
  };
}

function ProjectLayout() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  return (
    <DashboardWorkspaceProvider isDemo={false} projectId={projectId}>
      <AppShell />
    </DashboardWorkspaceProvider>
  );
}

function leaf(
  parent: AnyRoute,
  path: string,
  validateSearch?: (search: Record<string, unknown>) => unknown,
): AnyRoute {
  return createRoute({
    getParentRoute: () => parent,
    path,
    ...(validateSearch ? { validateSearch } : {}),
    component: () => <div data-testid="page" />,
  });
}

function account(role: "owner" | "member"): AccountResponse {
  return {
    user: {
      id: "u-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      emailVerified: true,
      image: null,
      role: "user",
    },
    workspaces: [
      {
        id: "w-1",
        name: "Acme",
        slug: "acme",
        role,
        projects: [{ id: "p-1", name: "Web", role }],
      },
    ],
    activeWorkspaceId: "w-1",
    isAdmin: false,
  };
}
