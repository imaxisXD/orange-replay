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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
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

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

// A doorway-shaped location: an explicit window plus a lens, a doorway pin, a
// selection, and a sort — every non-window key a tab click must drop.
const SEEDED_SEARCH =
  "?from=1000&to=2000&country=US&warehouse_version=5&selected=s-1&sort=friction";

describe("rendered top-nav date-range carry", () => {
  afterEach(() => {
    restoreProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
    restoreProperty(window, "matchMedia", originalMatchMedia);
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
  });

  it("shows demo tabs and carries only the window on every tab", async () => {
    const { container, main, tabs, teardown } = await renderShell(`/demo/sessions${SEEDED_SEARCH}`);
    expect(tabs.map((tab) => tab.text)).toEqual(["Overview", "Sessions", "Live"]);
    await openWebsiteMenu(container);
    expect(document.body.textContent).not.toContain("Add website");
    for (const tab of tabs) assertCarriesWindowOnly(tab.href);
    expect(main?.classList).toContain("dashboard-main");
    expect(main?.className).not.toContain("transition-[max-width]");
    const scrollViewports = container.querySelectorAll<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    expect([...scrollViewports].map((viewport) => viewport.tabIndex)).toEqual([-1, -1, -1]);
    // Active-tab reset: clicking the current Sessions tab also drops the lenses.
    const active = tabs.find((tab) => tab.text === "Sessions");
    expect(active?.href).toContain("/demo/sessions?");
    assertCarriesWindowOnly(active?.href ?? "");
    await teardown();
  });

  it("animates the workspace transform when a selected session returns to Overview", async () => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement): number {
        if (this.classList.contains("max-w-475")) return 1900;
        if (this.classList.contains("max-w-300")) return 1200;
        return 0;
      },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList =>
        ({
          addEventListener: vi.fn(),
          addListener: vi.fn(),
          dispatchEvent: vi.fn(() => true),
          matches: true,
          media: query,
          onchange: null,
          removeEventListener: vi.fn(),
          removeListener: vi.fn(),
        }) as MediaQueryList,
    });

    const { container, main, teardown } = await renderShell(`/demo/sessions${SEEDED_SEARCH}`);
    expect(main?.classList).toContain("max-w-475");

    const overviewTab = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
      (anchor) => anchor.textContent?.trim() === "Overview",
    );
    expect(overviewTab).toBeDefined();
    await act(async () => overviewTab?.click());
    await vi.waitFor(() => {
      expect(main?.classList).toContain("max-w-300");
      expect(main?.classList).toContain("dashboard-main-width-moving");
    });
    expect(main?.style.getPropertyValue("--workspace-width-start-scale")).toBe(String(1900 / 1200));

    const childAnimationEnd = new Event("animationend", { bubbles: true });
    Object.defineProperty(childAnimationEnd, "animationName", { value: "replay-child-enter" });
    main?.append(document.createElement("span"));
    main?.lastElementChild?.dispatchEvent(childAnimationEnd);
    expect(main?.classList).toContain("dashboard-main-width-moving");

    const workspaceAnimationEnd = new Event("animationend");
    Object.defineProperty(workspaceAnimationEnd, "animationName", {
      value: "dashboard-main-width",
    });
    main?.dispatchEvent(workspaceAnimationEnd);
    expect(main?.classList).not.toContain("dashboard-main-width-moving");

    await teardown();
  });

  it("shows the manager tab set and carries only the window", async () => {
    const { container, tabs, teardown } = await renderShell(
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
    const header = container.querySelector("header");
    expect(header?.querySelector('[aria-label="Website"]')?.textContent).toContain("Web");
    expect(header?.querySelector('img[src*="/api/v1/favicon"]')?.getAttribute("src")).toBe(
      "/api/v1/favicon?website=https%3A%2F%2Fexample.com&v=3",
    );
    expect(header?.textContent).not.toContain("Add");
    expect(header?.textContent).not.toContain("Add website");
    await openWebsiteMenu(container);
    expect(document.body.textContent).toContain("Websites");
    expect(document.body.textContent).toContain("Add website");
    expect(document.body.textContent).not.toContain("Add workspace");
    for (const tab of tabs) assertCarriesWindowOnly(tab.href);
    await teardown();
  });

  it("keeps account names and internal ids out of the Website label", async () => {
    const accountData = account("owner");
    accountData.workspaces.push({
      id: "org_demo",
      name: "org_demo",
      slug: "org-demo",
      role: "owner",
      projects: [
        {
          id: "project_demo",
          name: "project_demo",
          role: "owner",
          websiteOrigin: "https://ndle.app",
        },
      ],
    });

    const first = await renderShell("/projects/p-1/overview", accountData);
    const firstWebsite = first.container.querySelector('[aria-label="Website"]');
    expect(firstWebsite?.textContent).toContain("Web");
    expect(firstWebsite?.textContent).not.toContain("Acme");
    await first.teardown();

    const internal = await renderShell("/projects/project_demo/overview", accountData);
    const internalWebsite = internal.container.querySelector('[aria-label="Website"]');
    expect(internalWebsite?.textContent).toContain("New website");
    expect(internalWebsite?.textContent).not.toContain("org_demo");
    expect(internalWebsite?.textContent).not.toContain("project_demo");
    expect(internalWebsite?.querySelector("img")?.getAttribute("src")).toBe(
      "/api/v1/favicon?website=https%3A%2F%2Fndle.app&v=3",
    );
    await internal.teardown();
  });

  it("hides Settings/Install for a non-manager and still carries the window", async () => {
    const { container, tabs, teardown } = await renderShell(
      `/projects/p-1/sessions${SEEDED_SEARCH}`,
      account("member"),
    );
    expect(tabs.map((tab) => tab.text)).toEqual(["Overview", "Sessions", "Live"]);
    await openWebsiteMenu(container);
    expect(document.body.textContent).not.toContain("Add website");
    for (const tab of tabs) assertCarriesWindowOnly(tab.href);
    await teardown();
  });

  it("opens Website onboarding without creating another container up front", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const { container, router, teardown } = await renderShell(
      "/projects/p-1/overview",
      account("owner"),
    );
    await chooseAddAction(container, "Add website");

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe("/onboarding/p-1/website");
    });
    expect(fetchMock).not.toHaveBeenCalledWith("/api/v1/projects", expect.anything());
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

async function chooseAddAction(container: HTMLElement, action: string): Promise<void> {
  await openWebsiteMenu(container);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === action,
  );
  if (option === undefined) throw new Error(`Add option not found: ${action}`);
  await act(async () => option.click());
}

async function openWebsiteMenu(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector<HTMLElement>('[aria-label="Website"]');
  if (trigger === null) throw new Error("Website control not found.");
  if (trigger.getAttribute("aria-expanded") === "true") return;
  await act(async () => trigger.click());
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
  const onboardingWebsite = createRoute({
    getParentRoute: () => rootRoute,
    path: "/onboarding/$projectId/website",
    component: () => <div data-testid="onboarding-website" />,
  });

  const routeTree = rootRoute.addChildren([
    onboardingWebsite,
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
  const main = container.querySelector("main");

  return {
    container,
    main,
    queryClient,
    router,
    tabs,
    teardown: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
    },
  };
}

function restoreProperty(
  target: object,
  name: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, name);
    return;
  }
  Object.defineProperty(target, name, descriptor);
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
        projects: [{ id: "p-1", name: "Web", role, websiteOrigin: "https://example.com" }],
      },
    ],
    activeWorkspaceId: "w-1",
    isAdmin: false,
  };
}
