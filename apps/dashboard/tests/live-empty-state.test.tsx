// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AccountProjectRole, AccountResponse } from "@orange-replay/shared";
import { clearDashboardAccess } from "../src/lib/dashboard-access";
import { DashboardWorkspaceProvider } from "../src/lib/dashboard-workspace";
import { LivePage } from "../src/routes/live";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The empty state links out with router Links, and these tests render the page
// without a router. The stub keeps the destination assertable as an href.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

describe("live empty state", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearDashboardAccess();
    document.body.replaceChildren();
  });

  it("asks an owner with no events ever to install the snippet", async () => {
    const { container, teardown } = await renderLive({ firstEventAt: null, role: "owner" });
    await settleUntil(
      () =>
        container.querySelector('[data-slot="empty-content"] a')?.textContent ===
        "Install the snippet",
    );

    expect(container.textContent).toContain("No events from your site yet");
    expect(container.textContent).toContain("Add the snippet to your site");
    expect(ctaLink(container).textContent).toBe("Install the snippet");
    expect(ctaLink(container).getAttribute("href")).toBe("/projects/$projectId/install");

    await teardown();
  });

  it("points an installed project at its recordings and keeps claiming the 5s refresh", async () => {
    const { container, teardown } = await renderLive({ firstEventAt: 1_700_000_000_000 });

    expect(container.textContent).toContain("No one is browsing right now");
    expect(container.textContent).toContain("refreshes every 5 seconds");
    expect(ctaLink(container).textContent).toBe("Browse recorded sessions");
    expect(ctaLink(container).getAttribute("href")).toBe("/projects/$projectId/sessions");

    await teardown();
  });

  it("never offers the install page to a member who cannot reach it", async () => {
    const { container, teardown, fetchMock } = await renderLive({ role: "member" });

    expect(container.textContent).toContain("No one is browsing right now");
    expect(ctaLink(container).textContent).toBe("Browse recorded sessions");
    expect(requestedUrls(fetchMock).some((url) => url.includes("/install-status"))).toBe(false);

    await teardown();
  });

  it("sends the demo workspace to the demo recordings without checking install status", async () => {
    const { container, teardown, fetchMock } = await renderLive({ isDemo: true });

    expect(ctaLink(container).getAttribute("href")).toBe("/demo/sessions");
    expect(requestedUrls(fetchMock).some((url) => url.includes("/install-status"))).toBe(false);

    await teardown();
  });

  it("hides the live badge and its cadence note while nothing is live", async () => {
    const { container, teardown } = await renderLive({ firstEventAt: 1_700_000_000_000 });

    expect(container.textContent).not.toContain("Live now");
    expect(container.textContent).not.toContain("updates every 5s");

    await teardown();
  });
});

async function renderLive(
  options: { firstEventAt?: number | null; isDemo?: boolean; role?: AccountProjectRole } = {},
): Promise<{
  container: HTMLElement;
  fetchMock: ReturnType<typeof vi.fn>;
  root: Root;
  teardown: () => Promise<void>;
}> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes("/live")) return jsonResponse({ sessions: [], truncated: false });
    if (url.includes("/account")) return jsonResponse(account(options.role ?? "owner"));
    if (url.includes("/install-status")) {
      return jsonResponse({ firstEventAt: options.firstEventAt ?? null });
    }
    throw new Error(`Unexpected dashboard request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DashboardWorkspaceProvider isDemo={options.isDemo ?? false} projectId="project-1">
          <LivePage />
        </DashboardWorkspaceProvider>
      </QueryClientProvider>,
    );
  });

  // Live sessions, then the account, then install status: each query only starts
  // once the previous render committed, so the empty state arrives over several
  // flushes rather than one.
  await settleUntil(() => container.querySelector('[data-slot="empty-content"] a') !== null);

  return {
    container,
    fetchMock,
    root,
    teardown: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
    },
  };
}

async function settleUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for the live page to settle");
}

function ctaLink(container: HTMLElement): HTMLAnchorElement {
  const link = container.querySelector<HTMLAnchorElement>('[data-slot="empty-content"] a');
  if (link === null) throw new Error("Could not find the empty state call to action");
  return link;
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => requestUrl(call[0] as string | URL | Request));
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function account(role: AccountProjectRole): AccountResponse {
  return {
    user: {
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      image: null,
      role: "user",
    },
    workspaces: [
      {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        role,
        projects: [{ id: "project-1", name: "Project", role }],
      },
    ],
    activeWorkspaceId: "workspace-1",
    isAdmin: false,
  };
}
